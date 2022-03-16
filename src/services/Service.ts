import { Logger } from "tslog";
import { BigNumber, ethers } from "ethers";
import { Processor } from "bullmq";
import { Paw } from "../Paw";
import config from "../config";
import { UsersDepositsService } from "./UsersDepositsService";
import InvalidSignatureError from "../errors/InvalidSignatureError";
import InvalidOwner from "../errors/InvalidOwner";
import InsufficientBalanceError from "../errors/InsufficientBalanceError";
import { ClaimResponse } from "../models/responses/ClaimResponse";
import { Blockchain } from "../Blockchain";
import ProcessingQueue from "./queuing/ProcessingQueue";
import { OperationsNames } from "../models/operations/Operation";
import PawUserWithdrawal from "../models/operations/PawUserWithdrawal";
import SwapPawToWPAW from "../models/operations/SwapPawToWPAW";
import SwapWPAWToPaw from "../models/operations/SwapWPAWToPaw";
import History from "../models/responses/History";
import BlockchainScanQueue from "./queuing/BlockchainScanQueue";
import { PawWalletsBlacklist } from "./PawWalletsBlacklist";

class Service {
	paw: Paw;

	public blockchain: Blockchain;

	private usersDepositsService: UsersDepositsService;

	private processingQueue: ProcessingQueue;

	private blockchainScanQueue: BlockchainScanQueue;

	private pawWalletsBlacklist: PawWalletsBlacklist;

	private log: Logger = config.Logger.getChildLogger();

	constructor(
		usersDepositsService: UsersDepositsService,
		processingQueue: ProcessingQueue,
		blockchainScanQueue: BlockchainScanQueue,
		pawWalletsBlacklist: PawWalletsBlacklist
	) {
		this.processingQueue = processingQueue;
		this.blockchainScanQueue = blockchainScanQueue;
		this.paw = new Paw(
			config.PawUsersDepositsHotWallet,
			config.PawUsersDepositsColdWallet,
			config.PawSeed,
			config.PawSeedIdx,
			config.PawRepresentative,
			usersDepositsService,
			this.processingQueue
		);
		this.processingQueue.registerProcessor(
			OperationsNames.PawWithdrawal,
			async (job) => {
				const withdrawal: PawUserWithdrawal = job.data;
				const processor = this.withdrawalProcessor(withdrawal.signature);
				return processor(job);
			}
		);
		this.processingQueue.registerProcessor(
			OperationsNames.SwapToWPAW,
			async (job) => {
				const swap: SwapPawToWPAW = job.data;
				const { receipt, uuid, wpawBalance } = await this.processSwapToWPAW(
					swap
				);
				return {
					pawWallet: swap.from,
					blockchainWallet: swap.blockchainWallet,
					swapped: swap.amount,
					receipt,
					uuid,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(swap.from)
					),
					wpawBalance: ethers.utils.formatEther(wpawBalance),
				};
			}
		);
		this.processingQueue.registerProcessor(
			OperationsNames.SwapToPAW,
			async (job) => {
				const swap: SwapWPAWToPaw = job.data;
				const { hash, wpawBalance } = await this.processSwapToPAW(swap);
				return {
					pawWallet: swap.pawWallet,
					swapped: swap.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							swap.pawWallet
						)
					),
					wpawBalance,
					transaction: hash,
					transactionLink: `${config.BlockchainBlockExplorerUrl}/tx/${hash}`,
				};
			}
		);
		this.blockchain = new Blockchain(
			usersDepositsService,
			this.blockchainScanQueue
		);
		this.blockchain.onSwapToPAW((swap: SwapWPAWToPaw) => this.swapToPAW(swap));
		this.usersDepositsService = usersDepositsService;
		this.pawWalletsBlacklist = pawWalletsBlacklist;
	}

	start(): void {
		this.processingQueue.start();
		this.blockchainScanQueue.start();
		this.paw.subscribeToPawNotificationsForWallet();
	}

	async getUserAvailableBalance(from: string): Promise<BigNumber> {
		return this.usersDepositsService.getUserAvailableBalance(from);
	}

	async claim(
		pawWallet: string,
		blockchainWallet: string,
		signature: string
	): Promise<ClaimResponse> {
		// verify signature
		if (
			!this.checkSignature(
				blockchainWallet,
				signature,
				`I hereby claim that the PAW address "${pawWallet}" is mine`
			)
		) {
			return ClaimResponse.InvalidSignature;
		}
		// check if the address is blacklisted
		const blacklisted = await this.pawWalletsBlacklist.isBlacklisted(
			pawWallet
		);
		if (blacklisted !== undefined) {
			this.log.warn(
				`Can't claim "${pawWallet}. This is a blacklisted wallet linked to ${blacklisted.alias}`
			);
			return ClaimResponse.Blacklisted;
		}
		// check if the user already did the claim process
		if (await this.usersDepositsService.hasClaim(pawWallet, blockchainWallet)) {
			return ClaimResponse.AlreadyDone;
		}
		// check if there is a pending claim
		if (!(await this.usersDepositsService.hasPendingClaim(pawWallet))) {
			return (await this.usersDepositsService.storePendingClaim(
				pawWallet,
				blockchainWallet
			))
				? ClaimResponse.Ok
				: ClaimResponse.Error;
		}
		// assume this is another use who tried to do this
		return ClaimResponse.InvalidOwner;
	}

	async withdrawPAW(
		pawWallet: string,
		amount: string,
		blockchainWallet: string,
		timestamp: number,
		signature: string
	): Promise<string> {
		return this.processingQueue.addPawUserWithdrawal({
			pawWallet,
			amount,
			blockchainWallet,
			signature,
			timestamp,
			attempt: 0,
		});
	}

	async processWithdrawPAW(
		withdrawal: PawUserWithdrawal,
		signature?: string
	): Promise<string> {
		const { pawWallet, amount, blockchainWallet, timestamp } = withdrawal;

		this.log.info(
			`Processing user withdrawal request of "${amount}" PAW from wallet "${pawWallet}"`
		);

		// check if request was already processed
		if (
			await this.usersDepositsService.containsUserWithdrawalRequest(withdrawal)
		) {
			this.log.warn(
				`User withdrawal request to "${pawWallet}" at ${timestamp} was already processed`
			);
			throw new Error(
				"Can't withdraw PAW as the transaction was already processed"
			);
		}

		// verify signature
		if (
			signature &&
			!this.checkSignature(
				blockchainWallet,
				signature,
				`Withdraw ${amount} PAW to my wallet "${pawWallet}"`
			)
		) {
			throw new InvalidSignatureError();
		}

		// verify is the claim was previously done
		if (!this.usersDepositsService.isClaimed(pawWallet)) {
			throw new Error(`Can't withdraw from unclaimed wallet ${pawWallet}`);
		} else if (
			!this.usersDepositsService.hasClaim(pawWallet, blockchainWallet)
		) {
			throw new Error("Can't withdraw from another Blockchain wallet");
		}

		const withdrawnAmount: BigNumber = ethers.utils.parseEther(amount);

		// check for positive amounts
		if (withdrawnAmount.isNegative()) {
			throw new Error("Can't withdraw negative amounts of PAW");
		}

		// check if deposits are greater than or equal to amount to withdraw
		const availableBalance: BigNumber = await this.usersDepositsService.getUserAvailableBalance(
			pawWallet
		);
		if (!availableBalance.gte(withdrawnAmount)) {
			const message = `User "${pawWallet}" has not deposited enough PAW for a withdrawal of ${amount} PAW. Deposited balance is: ${ethers.utils.formatEther(
				availableBalance
			)} PAW`;
			this.log.warn(message);
			throw new InsufficientBalanceError(message);
		}

		// send the PAW to the user
		const { pending, hash } = await this.eventuallySendPaw(withdrawal);

		if (pending || !hash) {
			return "";
		}

		// decrease user deposits
		await this.usersDepositsService.storeUserWithdrawal(
			pawWallet,
			withdrawnAmount,
			timestamp,
			hash
		);
		this.log.info(`Withdrew ${amount} PAW to "${pawWallet} with txn ${hash}"`);
		return hash;
	}

	async swapToWPAW(
		from: string,
		amount: number,
		blockchainWallet: string,
		timestamp: number,
		signature: string
	): Promise<string> {
		return this.processingQueue.addSwapToWPaw({
			from,
			amount,
			blockchainWallet,
			signature,
			timestamp,
		});
	}

	async processSwapToWPAW(swap: SwapPawToWPAW): Promise<any> {
		const { from, blockchainWallet, signature } = swap;
		const amountStr = swap.amount;
		// verify signature
		if (
			!this.checkSignature(
				blockchainWallet,
				signature,
				`Swap ${amountStr} PAW for wPAW with PAW I deposited from my wallet "${from}"`
			)
		) {
			throw new InvalidSignatureError();
		}
		// verify if there is a proper claim
		if (!(await this.usersDepositsService.hasClaim(from, blockchainWallet))) {
			throw new InvalidOwner();
		}

		const amount: BigNumber = ethers.utils.parseEther(amountStr.toString());

		// check for positive amounts
		if (amount.isNegative()) {
			throw new Error("Can't swap negative amounts of PAW");
		}

		// check if deposits are greater than or equal to amount to swap
		const availableBalance: BigNumber = await this.usersDepositsService.getUserAvailableBalance(
			from
		);
		if (!availableBalance.gte(amount)) {
			const message = `User "${from}" has not deposited enough PAW for a swap of ${amountStr} PAW. Deposited balance is: ${ethers.utils.formatEther(
				availableBalance
			)} PAW`;
			this.log.warn(message);
			throw new InsufficientBalanceError(message);
		}

		// create wPAW swap receipt
		const {
			receipt,
			uuid,
			wpawBalance,
		} = await this.blockchain.createMintReceipt(blockchainWallet, amount);
		// decrease user deposits
		// TODO: store signature?
		await this.usersDepositsService.storeUserSwapToWPaw(
			from,
			blockchainWallet,
			amount,
			swap.timestamp,
			receipt,
			uuid
		);
		console.log('from:' + from);
		console.log('blockchainWallet:' + blockchainWallet);
		console.log('amount:' + amount);
		console.log('receipt:' + receipt);
		console.log('uuid:' + uuid);
		return { receipt, uuid, wpawBalance };
	}

	async swapToPAW(swap: SwapWPAWToPaw): Promise<string> {
		return this.processingQueue.addSwapToPaw(swap);
	}

	async processSwapToPAW(swap: SwapWPAWToPaw): Promise<any> {
		this.log.info(
			`Swapping ${swap.amount} wPAW to PAW (txn: ${swap.hash}) into wallet "${swap.pawWallet}"...`
		);
		// check if the PAW were already sent
		if (await this.usersDepositsService.containsUserSwapToPaw(swap)) {
			this.log.warn(`Swap for transaction "${swap.hash}" was already done.`);
			return {
				hash: swap.hash,
				wpawBalance: swap.wpawBalance,
			};
		}
		// add the amount to user deposits and store user swap from wPAW to PAW
		await this.usersDepositsService.storeUserSwapToPaw(swap);
		return {
			hash: swap.hash,
			wpawBalance: swap.wpawBalance,
		};
	}

	async getHistory(
		blockchainWallet: string,
		pawWallet: string
	): Promise<History> {
		const history = new History();
		history.deposits = await this.usersDepositsService.getDeposits(pawWallet);
		history.withdrawals = await this.usersDepositsService.getWithdrawals(
			pawWallet
		);
		history.swaps = await this.usersDepositsService.getSwaps(
			blockchainWallet,
			pawWallet
		);
		return history;
	}

	async getPendingWithdrawalsAmount(): Promise<BigNumber> {
		return this.processingQueue.getPendingWithdrawalsAmount();
	}

	checkSignature(
		blockchainWallet: string,
		signature: string,
		expected: string
	): boolean {
		this.log.trace(`Checking signature '${signature}'`);
		const author = ethers.utils.verifyMessage(expected, signature);
		const sanitizedAddress = ethers.utils.getAddress(blockchainWallet);
		if (author !== sanitizedAddress) {
			this.log.warn(
				`Signature is invalid. ${sanitizedAddress} sent a signed message pretending to be from ${author}`
			);
		}
		return author === sanitizedAddress;
	}

	private async eventuallySendPaw(
		withdrawal: PawUserWithdrawal
	): Promise<{ pending: boolean; hash?: string }> {
		const amountStr = withdrawal.amount;
		const amount: BigNumber = ethers.utils.parseEther(amountStr);
		// check if hot wallet balance is greater than or equal to amount to withdraw
		const hotWalletBalance: BigNumber = await this.paw.getBalance(
			config.PawUsersDepositsHotWallet
		);
		if (hotWalletBalance.lt(amount)) {
			this.log.warn(
				`Hot wallet balance of ${ethers.utils.formatEther(
					hotWalletBalance
				)} PAW is not enough to proceed with a withdrawal of ${amountStr} PAW. Adding a pending withdrawal to queue.`
			);
			await this.processingQueue.addPawUserPendingWithdrawal(withdrawal);
			return { pending: true };
		}
		// send the PAW to the user
		const hash = await this.paw.sendPaw(withdrawal.pawWallet, amount);
		return { pending: false, hash };
	}

	private withdrawalProcessor(
		signature?: string
	): Processor<PawUserWithdrawal, any, string> {
		return async (job) => {
			const withdrawal: PawUserWithdrawal = job.data;
			const hash = await this.processWithdrawPAW(withdrawal, signature);
			if (hash) {
				return {
					pawWallet: withdrawal.pawWallet,
					withdrawal: withdrawal.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							withdrawal.pawWallet
						)
					),
					transaction: hash,
				};
			}
			if (withdrawal.attempt === 1) {
				return {
					pawWallet: withdrawal.pawWallet,
					withdrawal: withdrawal.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							withdrawal.pawWallet
						)
					),
					transaction: "",
				};
			}
			// throw an error just to get the job as failed and removed as a new one was created instead
			throw new Error("Old pending withdrawal request replaced by a new one");
		};
	}
}

export { Service };
