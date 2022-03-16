import { Processor } from "bullmq";
import { BigNumber } from "ethers";
import JobListener from "./JobListener";
import { OperationsNames } from "../../models/operations/Operation";
import PawUserDeposit from "../../models/operations/PawUserDeposit";
import PawUserWithdrawal from "../../models/operations/PawUserWithdrawal";
import SwapPawToWPAW from "../../models/operations/SwapPawToWPAW";
import SwapWPAWToPaw from "../../models/operations/SwapWPAWToPaw";

interface ProcessingQueue {
	start(): void;
	registerProcessor(jobName: OperationsNames, processor: Processor): void;
	addJobListener(listener: JobListener): void;

	addPawUserDeposit(deposit: PawUserDeposit): Promise<any>;
	addPawUserWithdrawal(withdrawal: PawUserWithdrawal): Promise<any>;
	addPawUserPendingWithdrawal(
		withdrawal: PawUserWithdrawal
	): Promise<any>;

	addSwapToWPaw(swap: SwapPawToWPAW): Promise<string>;
	addSwapToPaw(swap: SwapWPAWToPaw): Promise<string>;

	getPendingWithdrawalsAmount(): Promise<BigNumber>;
}

export default ProcessingQueue;
