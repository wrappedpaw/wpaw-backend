import { Logger } from "tslog";
import { BigNumber } from "ethers";
import config from "../config";
import { UsersDepositsStorage } from "../storage/UsersDepositsStorage";
import Withdrawal from "../models/operations/Withdrawal";
import SwapWPAWToPaw from "../models/operations/SwapWPAWToPaw";

class UsersDepositsService {
	private usersDepositsStorage: UsersDepositsStorage;

	private log: Logger = config.Logger.getChildLogger();

	constructor(usersDepositsStorage: UsersDepositsStorage) {
		this.usersDepositsStorage = usersDepositsStorage;
	}

	async getUserAvailableBalance(from: string): Promise<BigNumber> {
		const balance = await this.usersDepositsStorage.getUserAvailableBalance(
			from
		);
		return balance;
	}

	async hasPendingClaim(pawAddress: string): Promise<boolean> {
		return this.usersDepositsStorage.hasPendingClaim(pawAddress);
	}

	async storePendingClaim(
		pawAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		if (await this.usersDepositsStorage.hasPendingClaim(pawAddress)) {
			return false;
		}
		return this.usersDepositsStorage.storePendingClaim(
			pawAddress,
			blockchainAddress
		);
	}

	async isClaimed(pawAddress: string): Promise<boolean> {
		return this.usersDepositsStorage.isClaimed(pawAddress);
	}

	async hasClaim(
		pawAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		return this.usersDepositsStorage.hasClaim(pawAddress, blockchainAddress);
	}

	async confirmClaim(pawAddress: string): Promise<boolean> {
		return this.usersDepositsStorage.confirmClaim(pawAddress);
	}

	async storeUserDeposit(
		pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		// check if the transaction wasn't already ingested!
		if (
			await this.usersDepositsStorage.containsUserDepositTransaction(
				pawAddress,
				hash
			)
		) {
			this.log.warn(
				`User deposit transaction ${hash} from ${pawAddress} was already processed. Skipping it...`
			);
			return;
		}
		// store the user deposit
		this.usersDepositsStorage.storeUserDeposit(
			pawAddress,
			amount,
			timestamp,
			hash
		);
	}

	async containsUserWithdrawalRequest(
		withdrawal: Withdrawal
	): Promise<boolean> {
		return this.usersDepositsStorage.containsUserWithdrawalRequest(
			withdrawal.pawWallet,
			withdrawal.timestamp
		);
	}

	async storeUserWithdrawal(
		pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		// check if the transaction wasn't already ingested!
		if (
			await this.usersDepositsStorage.containsUserWithdrawalRequest(
				pawAddress,
				timestamp
			)
		) {
			this.log.warn(
				`User withdrawal request ${hash} from ${pawAddress} was already processed. Skipping it...`
			);
			return;
		}
		// store the user withdrawal
		this.usersDepositsStorage.storeUserWithdrawal(
			pawAddress,
			amount,
			timestamp,
			hash
		);
	}

	async storeUserSwapToWPaw(
		pawWallet: string,
		blockchainWallet: string,
		amount: BigNumber,
		timestamp: number,
		receipt: string,
		uuid: string
	): Promise<void> {
		return this.usersDepositsStorage.storeUserSwapToWPaw(
			pawWallet,
			blockchainWallet,
			amount,
			timestamp,
			receipt,
			uuid
		);
	}

	async getLastBlockchainBlockProcessed(): Promise<number> {
		return this.usersDepositsStorage.getLastBlockchainBlockProcessed();
	}

	async setLastBlockchainBlockProcessed(block: number): Promise<void> {
		return this.usersDepositsStorage.setLastBlockchainBlockProcessed(block);
	}

	async storeUserSwapToPaw(event: SwapWPAWToPaw): Promise<void> {
		return this.usersDepositsStorage.storeUserSwapToPaw(event);
	}

	async containsUserSwapToPaw(event: SwapWPAWToPaw): Promise<boolean> {
		return this.usersDepositsStorage.swapToPawWasAlreadyDone(event);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getDeposits(pawWallet: string): Promise<Array<any>> {
		return this.usersDepositsStorage.getDeposits(pawWallet);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getWithdrawals(pawWallet: string): Promise<Array<any>> {
		return this.usersDepositsStorage.getWithdrawals(pawWallet);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getSwaps(blockchainAddress: string, pawWallet: string): Promise<Array<any>> {
		return this.usersDepositsStorage.getSwaps(blockchainAddress, pawWallet);
	}
}

export { UsersDepositsService };
