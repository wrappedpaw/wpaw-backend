import { BigNumber } from "ethers";
import SwapWPAWToPaw from "../models/operations/SwapWPAWToPaw";

interface UsersDepositsStorage {
	getUserAvailableBalance(from: string): Promise<BigNumber>;
	/*
	lockBalance(from: string): Promise<void>;
	unlockBalance(from: string): Promise<void>;
	isBalanceLocked(from: string): Promise<boolean>;
	*/

	hasPendingClaim(pawAddress: string): Promise<boolean>;
	storePendingClaim(
		pawAddress: string,
		blockchainAddress: string
	): Promise<boolean>;
	isClaimed(pawAddress: string): Promise<boolean>;
	hasClaim(pawAddress: string, blockchainAddress: string): Promise<boolean>;
	confirmClaim(pawAddress: string): Promise<boolean>;

	storeUserDeposit(
		pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void>;
	containsUserDepositTransaction(
		pawAddress: string,
		hash: string
	): Promise<boolean>;
	storeUserWithdrawal(
		pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void>;
	containsUserWithdrawalRequest(
		pawAddress: string,
		timestamp: number
	): Promise<boolean>;

	storeUserSwapToWPaw(
		pawAddress: string,
		blockchainAddress: string,
		amount: BigNumber,
		timestamp: number,
		receipt: string,
		uuid: string
	): Promise<void>;
	storeUserSwapToPaw(swap: SwapWPAWToPaw): Promise<void>;
	swapToPawWasAlreadyDone(swap: SwapWPAWToPaw): Promise<boolean>;

	getLastBlockchainBlockProcessed(): Promise<number>;
	setLastBlockchainBlockProcessed(block: number): Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getDeposits(pawAddress: string): Promise<Array<any>>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getWithdrawals(pawAddress: string): Promise<Array<any>>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getSwaps(blockchainAddress: string, pawAddress: string): Promise<Array<any>>;
}

export { UsersDepositsStorage };
