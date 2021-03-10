import * as banano from "@bananocoin/bananojs";
import * as WS from "websocket";
import { Logger } from "tslog";
import cron from "node-cron";
import { ethers, BigNumber } from "ethers";
import { UsersDepositsService } from "./services/UsersDepositsService";
import config from "./config";
import ProcessingQueue from "./services/queuing/ProcessingQueue";
import BananoUserDeposit from "./models/operations/BananoUserDeposit";
import { OperationsNames } from "./models/operations/Operation";
import BananoUserWithdrawal from "./models/operations/BananoUserWithdrawal";

class Banano {
	private usersDepositsHotWallet: string;

	private usersDepositsColdWallet: string;

	private seed: string;

	private seedIdx: number;

	private representative: string;

	private usersDepositsService: UsersDepositsService;

	private ws: WS.client;

	private processingQueue: ProcessingQueue;

	private log: Logger = config.Logger.getChildLogger();

	constructor(
		usersDepositsHotWallet: string,
		usersDepositsColdWallet: string,
		seed: string,
		seedIdx: number,
		representative: string,
		usersDepositsService: UsersDepositsService,
		processingQueue: ProcessingQueue
	) {
		this.usersDepositsHotWallet = usersDepositsHotWallet;
		this.usersDepositsColdWallet = usersDepositsColdWallet;
		this.usersDepositsService = usersDepositsService;
		this.seed = seed;
		this.seedIdx = seedIdx;
		this.representative = representative;
		this.processingQueue = processingQueue;
		this.processingQueue.registerProcessor(
			OperationsNames.BananoDeposit,
			async (job) => {
				const deposit: BananoUserDeposit = job.data;
				await this.processUserDeposit(
					deposit.sender,
					ethers.utils.parseEther(deposit.amount),
					deposit.hash
				);
				return {
					banWallet: deposit.sender,
					deposit: deposit.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							deposit.sender
						)
					),
				};
			}
		);

		banano.setBananodeApiUrl(config.BananoRPCAPI);
		// check every 5 miinutes if transactions were missed from the WebSockets API
		if (config.BananoPendingTransactionsThreadEnabled === true) {
			cron.schedule("*/5 * * * *", () => {
				this.processPendingTransactions(usersDepositsHotWallet);
			});
		} else {
			this.log.warn(
				"Ignoring checks of pending transactions. Only do this for running tests!"
			);
		}
	}

	public async sendBan(banAddress: string, amount: BigNumber): Promise<string> {
		this.log.debug(
			`Sending ${ethers.utils.formatEther(amount)} BAN to ${banAddress}`
		);
		return banano.sendBananoWithdrawalFromSeed(
			this.seed,
			this.seedIdx,
			banAddress,
			ethers.utils.formatEther(amount)
		);
	}

	async subscribeToBananoNotificationsForWallet(): Promise<void> {
		this.log.info(
			`Subscribing to hot wallet notifications for '${this.usersDepositsHotWallet}'...`
		);
		// eslint-disable-next-line new-cap
		this.ws = new WS.client();
		this.ws.addListener("connectFailed", Banano.wsConnectionFailed.bind(this));
		this.ws.addListener("connect", this.wsConnectionEstablished.bind(this));
		this.log.debug(
			`Connecting to banano node at '${config.BananoWebSocketsAPI}'...`
		);
		this.ws.connect(`ws://${config.BananoWebSocketsAPI}`);
	}

	private async wsMessageReceived(msg: WS.IMessage): Promise<void> {
		const notification = JSON.parse(msg.utf8Data);
		const sender = notification.message.account;
		const receiver = notification.message.block.link_as_account;
		const rawAmount = notification.message.amount;
		const amount: BigNumber = BigNumber.from(
			rawAmount.substring(0, rawAmount.length - 11)
		);
		const { hash } = notification.message;

		// filter transactions sent by the users deposits wallets
		if (
			sender === this.usersDepositsHotWallet ||
			sender === this.usersDepositsColdWallet
		) {
			await this.receiveTransaction(hash);
			return;
		}

		// this.log.trace(`Received message ${JSON.stringify(notification)}`);
		this.log.info(
			`User ${sender} deposited ${ethers.utils.formatEther(
				amount
			)} BAN in transaction ${hash}`
		);

		// ensure funds where sent to the proper wallet, just in case
		if (this.usersDepositsHotWallet !== receiver) {
			this.log.error(
				`BAN were deposited to another wallet than the users deposit wallet: ${receiver}`
			);
			this.log.error("Ignoring this deposit");
			this.log.trace(`Received message ${JSON.stringify(notification)}`);
		}
		// record the user deposit
		await this.queueUserDeposit(sender, amount, hash);
	}

	private wsConnectionEstablished(conn: WS.connection): void {
		this.log.debug("WS connection established to Banano node");
		conn.addListener("error", this.wsConnectionError.bind(this));
		conn.addListener("close", this.wsConnectionClosed.bind(this));
		conn.addListener("message", this.wsMessageReceived.bind(this));
		// subscribe to users deposits wallets notifications
		const subscriptionRequest = {
			action: "subscribe",
			topic: "confirmation",
			options: {
				all_local_accounts: true,
				accounts: [this.usersDepositsHotWallet],
			},
		};
		conn.sendUTF(JSON.stringify(subscriptionRequest));
	}

	private static wsConnectionFailed(err): void {
		console.error(
			`Couldn't connect to Banano WebSocket API at ${config.BananoWebSocketsAPI}`,
			err
		);
		// TODO: exit?
	}

	private wsConnectionError(err): void {
		this.log.error("Unexpected WS error", err);
		this.log.info("Reconnecting to WS API...");
		this.ws.connect(`ws://${config.BananoWebSocketsAPI}`);
	}

	private wsConnectionClosed(code: number, desc: string): void {
		this.log.info(`WS connection closed: code=${code}, desc=${desc}`);
		this.log.info("Reconnecting to WS API...");
		this.ws.connect(`ws://${config.BananoWebSocketsAPI}`);
	}

	async processPendingTransactions(wallet: string): Promise<void> {
		this.log.info(
			"Searching for pending transactions that were missed from the WS API"
		);
		const accountsPending = await banano.getAccountsPending(
			[wallet], // monitor users deposits wallet
			-1, // ask for all pending transactions
			true // ask for wallet who sent the transaction
		);
		if (accountsPending.blocks && accountsPending.blocks[wallet]) {
			const walletPendingTransactions = accountsPending.blocks[wallet];
			const transactionsHashes = [...Object.keys(walletPendingTransactions)];
			// eslint-disable-next-line no-restricted-syntax
			for (const hash of transactionsHashes) {
				const transaction = walletPendingTransactions[hash];
				const { amount, sender } = transaction;
				const banAmount: BigNumber = BigNumber.from(
					amount.substring(0, amount.length - 11)
				);
				// filter transactions sent by the users deposits wallets
				if (
					sender === this.usersDepositsHotWallet ||
					sender === this.usersDepositsColdWallet
				) {
					// eslint-disable-next-line no-await-in-loop
					await this.receiveTransaction(hash);
					return;
				}
				this.log.debug(
					`Got missed transaction of ${ethers.utils.formatEther(
						banAmount
					)} BAN from ${sender} in transaction "${hash}"`
				);
				// record the user deposit
				// eslint-disable-next-line no-await-in-loop
				await this.queueUserDeposit(sender, banAmount, hash);
			}
		} else {
			this.log.debug("No pending transactions...");
		}
	}

	async queueUserDeposit(
		sender: string,
		amount: BigNumber,
		hash: string
	): Promise<void> {
		return this.processingQueue.addBananoUserDeposit({
			sender,
			amount: ethers.utils.formatEther(amount),
			hash,
		});
	}

	async processUserDeposit(
		sender: string,
		amount: BigNumber,
		hash: string
	): Promise<void> {
		this.log.info(
			`Processing user deposit transaction "${hash}" from wallet ${sender}`
		);

		// check if a pending claim is available
		if (await this.usersDepositsService.hasPendingClaim(sender)) {
			// confirm it
			await this.usersDepositsService.confirmClaim(sender);
		}

		// check if there is a valid claim
		if (!(await this.usersDepositsService.isClaimed(sender))) {
			const formattedAmount = ethers.utils.formatEther(amount);
			this.log.warn(
				`No claim were made for "${sender}". Sending back the ${formattedAmount} BAN deposited`
			);
			await this.receiveTransaction(hash);
			// send back the BAN!
			try {
				await this.sendBan(sender, amount);
			} catch (err) {
				this.log.error("Unexpected error", err);
			}
		} else {
			// record the user deposit
			this.usersDepositsService.storeUserDeposit(sender, amount, hash);
			await this.receiveTransaction(hash);
			await this.eventuallySendToColdWallet();
		}
	}

	async receiveTransaction(hash: string): Promise<void> {
		// create receive transaction
		try {
			await banano.receiveBananoDepositsForSeed(
				this.seed,
				this.seedIdx,
				this.representative,
				hash
			);
		} catch (err) {
			this.log.error("Unexpected error", err);
			this.log.error(err);
		}
	}

	private async eventuallySendToColdWallet() {
		// get balance of hot wallet
		const hotWalletBalance: BigNumber = await this.getTotalBalance(
			this.usersDepositsHotWallet
		);
		this.log.debug(
			`Hot wallet balance: ${ethers.utils.formatEther(hotWalletBalance)} BAN`
		);
		const minimumBanInHotWallet = ethers.utils.parseEther(
			config.BananoUsersDepositsHotWalletMinimum
		);
		// check if hot wallet minimum is reached
		const amountAboveMinimum = hotWalletBalance.sub(minimumBanInHotWallet);
		// if not, nothing has to be send to the cold wallet
		if (amountAboveMinimum.lte(BigNumber.from(0))) {
			return;
		}
		// get balance of cold wallet
		const coldWalletBalance: BigNumber = await this.getTotalBalance(
			this.usersDepositsColdWallet
		);
		this.log.debug(
			`Cold wallet balance: ${ethers.utils.formatEther(coldWalletBalance)} BAN`
		);
		// get total BAN deposited balance
		const totalDeposits = hotWalletBalance.add(coldWalletBalance);
		this.log.debug(
			`Total deposits: ${ethers.utils.formatEther(totalDeposits)} BAN`
		);
		const ONE_HUNDRED = BigNumber.from(100);
		// compute hot balance over total deposits
		const hotRatio = hotWalletBalance.mul(ONE_HUNDRED).div(totalDeposits);
		this.log.debug(`Hot ratio: ${hotRatio}`);
		// retreive target ratio
		const targetRatio = BigNumber.from(
			config.BananoUsersDepositsHotWalletToColdWalletRatio
		);
		this.log.debug(`Target ratio: ${targetRatio}`);
		// if above target ratio, send extra to cold wallet
		if (hotRatio.gt(targetRatio)) {
			// compute amount to send to cold wallet
			let amount = totalDeposits
				.mul(ONE_HUNDRED.sub(targetRatio))
				.div(ONE_HUNDRED)
				.sub(coldWalletBalance);
			// check if enough BAN would be left in hot wallet
			if (hotWalletBalance.sub(amount).lt(minimumBanInHotWallet)) {
				amount = hotWalletBalance.sub(
					ethers.utils.parseEther(config.BananoUsersDepositsHotWalletMinimum)
				);
			}
			this.log.info(
				`Sending ${ethers.utils.formatEther(amount)} BAN to cold wallet`
			);
			// send BAN to cold wallet
			await this.sendBan(this.usersDepositsColdWallet, amount);
		}
	}

	// eslint-disable-next-line class-methods-use-this
	public async getBalance(wallet: string): Promise<BigNumber> {
		const rawAmount = await banano.getAccountBalanceRaw(wallet);
		const balance: BigNumber =
			rawAmount !== "0"
				? BigNumber.from(rawAmount.substring(0, rawAmount.length - 11))
				: BigNumber.from(0);
		return balance;
	}

	/**
	 * Return the sum of the balance and the pending balance
	 * @param wallet
	 * @returns the total balance, pending transactions included
	 */
	// eslint-disable-next-line class-methods-use-this
	public async getTotalBalance(wallet: string): Promise<BigNumber> {
		const rawBalances = await banano.getAccountBalanceAndPendingRaw(wallet);
		const rawBalance = rawBalances.balance;
		const rawPending = rawBalances.pending;
		const balance: BigNumber =
			rawBalance !== "0"
				? BigNumber.from(rawBalance.substring(0, rawBalance.length - 11))
				: BigNumber.from(0);
		const pending: BigNumber =
			rawPending !== "0"
				? BigNumber.from(rawPending.substring(0, rawPending.length - 11))
				: BigNumber.from(0);
		return balance.add(pending);
	}
}

export { Banano };
