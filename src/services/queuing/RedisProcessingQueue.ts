import { Queue, Processor, QueueScheduler, Job, QueueEvents } from "bullmq";
import { Logger } from "tslog";
import { ethers, BigNumber } from "ethers";
import { Operation, OperationsNames } from "../../models/operations/Operation";
import PawUserDeposit from "../../models/operations/PawUserDeposit";
import PawUserWithdrawal from "../../models/operations/PawUserWithdrawal";
import SwapPawToWPAW from "../../models/operations/SwapPawToWPAW";
import SwapWPAWToPaw from "../../models/operations/SwapWPAWToPaw";
import ProcessingQueue from "./ProcessingQueue";
import ProcessingQueueWorker from "./ProcessingQueueWorker";
import config from "../../config";
import JobListener from "./JobListener";

const QUEUE_NAME = "operations-queue";

class RedisProcessingQueue implements ProcessingQueue {
	private processingQueue: Queue<Operation, any, string>;

	private worker: ProcessingQueueWorker;

	public static PENDING_WITHDRAWAL_RETRY_DELAY = 1 * 60 * 1_000;

	private log: Logger = config.Logger.getChildLogger();

	public constructor() {
		this.processingQueue = new Queue(QUEUE_NAME, {
			connection: {
				host: config.RedisHost,
			},
			defaultJobOptions: {
				timeout: 30_000,
				attempts: 3,
				backoff: {
					type: "exponential",
					delay: 1_000,
				},
				removeOnComplete: 100_000,
				removeOnFail: false,
			},
		});
		const processingQueueEvents = new QueueEvents(QUEUE_NAME, {
			connection: {
				host: config.RedisHost,
			},
		});
		this.worker = new ProcessingQueueWorker(QUEUE_NAME);
		this.worker.pause();
	}

	start(): void {
		this.worker.resume();
		const queueScheduler = new QueueScheduler(QUEUE_NAME, {
			connection: {
				host: config.RedisHost,
			},
		});
	}

	registerProcessor(jobName: OperationsNames, processor: Processor): void {
		this.worker.registerProcessorForJobNamed(jobName, processor);
	}

	addJobListener(listener: JobListener): void {
		this.worker.on("completed", async (job: Job) => {
			this.log.debug(
				`Job "${job.name}" (ID: ${job.id}) completed with: ${JSON.stringify(
					job.returnvalue
				)}`
			);
			// const job = await Job.fromId(this.processingQueue, jobId);
			this.log.trace(`Completed job: ${JSON.stringify(job)}`);
			listener.onJobCompleted(job.id ?? job.name, job.name, job.returnvalue);
		});
		this.worker.on("failed", async (job: Job) => {
			if (job.id && !job.id.startsWith("pending-")) {
				this.log.error(`Job "${job.name}" (ID: ${job.id}) failed`);
				this.log.error(`Failure reason is:\n${job.failedReason}`);
				this.log.error(`Stacktrace is:\n${job.stacktrace}`);
			}
		});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async addPawUserDeposit(deposit: PawUserDeposit): Promise<any> {
		this.processingQueue.add(OperationsNames.PawDeposit, deposit, {
			jobId: `${OperationsNames.PawDeposit}-${deposit.sender}-${deposit.hash}`,
			timestamp: deposit.timestamp,
		});
		this.log.debug(`Added paw deposit to queue: ${JSON.stringify(deposit)}`);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async addPawUserWithdrawal(
		withdrawal: PawUserWithdrawal
	): Promise<any> {
		this.processingQueue.add(OperationsNames.PawWithdrawal, withdrawal, {
			jobId: `${OperationsNames.PawWithdrawal}-${withdrawal.pawWallet}-${withdrawal.timestamp}`,
			timestamp: withdrawal.timestamp,
		});
		this.log.debug(
			`Added paw withdrawal to queue: ${JSON.stringify(withdrawal)}`
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async addPawUserPendingWithdrawal(
		_withdrawal: PawUserWithdrawal
	): Promise<any> {
		const withdrawal = _withdrawal;
		withdrawal.attempt = _withdrawal.attempt + 1;
		await this.processingQueue.add(
			OperationsNames.PawWithdrawal,
			withdrawal,
			{
				jobId: `pending-${OperationsNames.PawWithdrawal}-${withdrawal.pawWallet}-${withdrawal.timestamp}-attempt-${withdrawal.attempt}`,
				delay:
					withdrawal.attempt *
					RedisProcessingQueue.PENDING_WITHDRAWAL_RETRY_DELAY,
				timestamp: withdrawal.timestamp,
				removeOnFail: true,
			}
		);
		this.log.debug(
			`Scheduled paw pending withdrawal attemp #${
				withdrawal.attempt
			} to queue: ${JSON.stringify(withdrawal)}`
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async addSwapToWPaw(swap: SwapPawToWPAW): Promise<any> {
		this.processingQueue.add(OperationsNames.SwapToWPAW, swap, {
			jobId: `${OperationsNames.SwapToWPAW}-${swap.from}-${swap.timestamp}`,
			timestamp: swap.timestamp,
		});
		this.log.debug(`Added swap PAW -> wPAW to queue: ${JSON.stringify(swap)}`);
	}

	async addSwapToPaw(swap: SwapWPAWToPaw): Promise<any> {
		const job = await this.processingQueue.add(
			OperationsNames.SwapToPAW,
			swap,
			{
				jobId: `${OperationsNames.SwapToPAW}-${swap.blockchainWallet}-${swap.hash}`,
				timestamp: swap.timestamp,
			}
		);
		this.log.debug(
			`Added swap wPAW -> PAW to queue: '${job.id}' -- ${JSON.stringify(swap)}`
		);
	}

	async getPendingWithdrawalsAmount(): Promise<BigNumber> {
		// get waiting jobs
		const waitingJobs = await this.processingQueue.getWaiting(0, 1_000_000);
		const delayedJobs = await this.processingQueue.getDelayed(0, 1_000_000);
		const allJobs = waitingJobs.concat(delayedJobs);
		return (
			allJobs
				// safeguard for pending withdrawals, although we don't expect anything else
				.filter(
					(job: Job) =>
						job.id &&
						job.id.startsWith(`pending-${OperationsNames.PawWithdrawal}`)
				)
				// extract withdrawal amount
				.map((job: Job) => {
					const withdrawal = job.data as PawUserWithdrawal;
					return ethers.utils.parseEther(withdrawal.amount);
				})
				// sum all pending amounts
				.reduce(
					(acc: BigNumber, amount: BigNumber) => acc.add(amount),
					BigNumber.from(0)
				)
		);
	}
}

export default RedisProcessingQueue;
