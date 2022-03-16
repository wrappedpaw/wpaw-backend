import { ethers, BigNumber, Wallet } from "ethers";
import { Logger } from "tslog";
import {
	WPAWToken,
	// eslint-disable-next-line camelcase
	WPAWToken__factory,
} from "wpaw-smart-contract";
import SwapWPAWToPaw from "./models/operations/SwapWPAWToPaw";
import { SwapToPawEventListener } from "./models/listeners/SwapToPawEventListener";
import { UsersDepositsService } from "./services/UsersDepositsService";
import config from "./config";
import BlockchainScanQueue from "./services/queuing/BlockchainScanQueue";

class Blockchain {
	private wPAW!: WPAWToken;

	private wallet!: Wallet;

	private provider!: ethers.providers.JsonRpcProvider;

	private listeners: SwapToPawEventListener[] = [];

	private usersDepositsService: UsersDepositsService;

	private log: Logger = config.Logger.getChildLogger();

	constructor(
		usersDepositsService: UsersDepositsService,
		blockchainScanQueue: BlockchainScanQueue
	) {
		this.usersDepositsService = usersDepositsService;

		if (config.BlockchainNetworkName === "none") {
			return;
		}
		try {
			this.provider = new ethers.providers.JsonRpcProvider(
				config.BlockchainJsonRpc,
				{
					name: config.BlockchainNetworkName,
					chainId: config.BlockchainNetworkChainId,
				}
			);
			this.wallet = Wallet.fromMnemonic(
				config.BlockchainWalletMnemonic,
				`m/44'/60'/0'/0/${config.BlockchainWalletMnemonicSignerIndex}`
			).connect(this.provider);
			this.wPAW = WPAWToken__factory.connect(
				config.WPAWContractAddress,
				this.wallet
			);
			// listen for `SwapToPaw` events
			this.wPAW.on(
				this.wPAW.filters.SwapToPaw(null, null, null),
				async (
					blockchainWallet: string,
					pawWallet: string,
					amount: BigNumber,
					event: ethers.Event
				) => {
					const block = await this.provider.getBlock(event.blockNumber);
					const { timestamp } = block;
					const wpawBalance = await this.wPAW.balanceOf(blockchainWallet);
					await this.provider.waitForTransaction(event.transactionHash, 5);
					await this.handleSwapToPawEvents({
						blockchainWallet,
						pawWallet,
						amount: ethers.utils.formatEther(amount),
						wpawBalance: ethers.utils.formatEther(wpawBalance),
						hash: event.transactionHash,
						timestamp: timestamp * 1_000,
					});
				}
			);
			if (config.BlockchainWalletPendingTransactionsThreadEnabled === true) {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				blockchainScanQueue.registerProcessor("bc-scan", async (job) => {
					const { blockFrom, blockTo } = job.data;
					return this.processBlocks(blockFrom, blockTo);
				});
			} else {
				this.log.warn(
					"Ignoring checks of pending transactions. Only do this for running tests!"
				);
			}
		} catch (err) {
			this.log.error(
				"Couldn't properly initialize connection to Binance Smart Chain",
				err
			);
			throw err;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async createMintReceipt(address: string, amount: BigNumber): Promise<any> {
		this.log.debug(
			`Forging mint receipt for ${ethers.utils.formatEther(
				amount
			)} PAW to ${address}`
		);
		const uuid = Date.now();
		const payload = ethers.utils.defaultAbiCoder.encode(
			["address", "uint256", "uint256", "uint256"],
			[address, amount, uuid, await this.wallet.getChainId()]
		);
		const payloadHash = ethers.utils.keccak256(payload);
		const receipt = await this.wallet.signMessage(
			ethers.utils.arrayify(payloadHash)
		);
		
		const wpawBalance: BigNumber = await this.wPAW.balanceOf(address);
		return {
			receipt,
			uuid,
			wpawBalance,
		};
	}

	async processBlocks(blockFrom: number, blockTo: number): Promise<string> {
		const BLOCK_SLICE = 1_000;
		try {
			this.log.info(`Processing blocks from ${blockFrom} to ${blockTo}...`);

			const numberOfSlices: number =
				Math.floor((blockTo - blockFrom) / BLOCK_SLICE) + 1;
			this.log.trace(`# of slices: ${numberOfSlices}`);
			let blockSliceFrom: number = blockFrom;
			let blockSliceTo: number = Math.min(
				blockSliceFrom + BLOCK_SLICE - 1,
				blockTo
			);

			for (let slice = 0; slice < numberOfSlices; slice += 1) {
				this.log.debug(`Processing slice ${blockSliceFrom} -> ${blockSliceTo}`);
				// eslint-disable-next-line no-await-in-loop
				await this.processBlocksSlice(blockSliceFrom, blockSliceTo);
				this.log.debug(
					`Processed blocks slice from ${blockSliceFrom} to ${blockSliceTo}...`
				);
				blockSliceFrom += blockSliceTo - blockSliceFrom + 1;
				blockSliceTo += Math.min(BLOCK_SLICE, blockTo - blockSliceFrom + 1);
			}

			return `Processed blocks from ${blockFrom} to ${blockTo}...`;
		} catch (err) {
			this.log.error(`Couldn't process Blockchain blocks`, err);
			throw err;
		}
	}

	async processBlocksSlice(
		blockFrom: number,
		blockTo: number
	): Promise<string> {
		try {
			const logs = await this.wPAW.queryFilter(
				this.wPAW.filters.SwapToPaw(null, null, null),
				blockFrom,
				blockTo
			);
			console.debug(logs);
			const events = await Promise.all(
				logs.map(async (log:any) => {
					console.debug(log);
					const parsedLog = this.wPAW.interface.parseLog(log);
					console.debug(parsedLog);
					const block = await this.provider.getBlock(log.blockNumber);
					const { timestamp } = block;
					const { from, pawAddress, amount } = parsedLog.args;
					const wpawBalance = await this.wPAW.balanceOf(from);
					return {
						blockchainWallet: from,
						pawWallet: pawAddress,
						amount: ethers.utils.formatEther(BigNumber.from(amount)),
						wpawBalance: ethers.utils.formatEther(wpawBalance),
						hash: log.transactionHash,
						timestamp: timestamp * 1_000,
						checkUserBalance: false,
					};
				})
			);
			await Promise.all(
				events.map((event) => this.handleSwapToPawEvents(event))
			);
			this.usersDepositsService.setLastBlockchainBlockProcessed(blockTo);
			return `Processed blocks slice from ${blockFrom} to ${blockTo}...`;
		} catch (err) {
			this.log.error(
				`Couldn't process Blockchain blocks slice ${blockFrom} to ${blockTo}`,
				err
			);
			throw err;
		}
	}
	//private async handleSwapToPawEvents(swap: SwapWPAWToPaw): Promise<void> {
	private async handleSwapToPawEvents(swap: any): Promise<void> {
		this.log.debug(
			`Detected a SwapToPaw event. From: ${swap.blockchainWallet}, to: ${swap.pawWallet}, amount: ${swap.amount}, hash: ${swap.hash}`
		);
		if (!swap.blockchainWallet) {
			throw new Error("Missing Blockchain address in Blockchain event!");
		}
		if (!swap.pawWallet) {
			throw new Error("Missing PAW address in Blockchain event!");
		}
		if (!swap.amount) {
			throw new Error("Missing amount in Blockchain event!");
		}
		// notify listeners
		this.listeners.forEach((listener) => listener(swap));
	}

	onSwapToPAW(listener: SwapToPawEventListener): void {
		this.listeners.push(listener);
	}
}

export { Blockchain };
