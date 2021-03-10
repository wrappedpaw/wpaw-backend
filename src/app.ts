import express, { Application, Request, Response } from "express";
import cors from "cors";
import { Logger } from "tslog";
import { ethers } from "ethers";
import SSEManager from "./services/sse/SSEManager";
import { Service } from "./services/Service";
import { UsersDepositsStorage } from "./storage/UsersDepositsStorage";
import { RedisUsersDepositsStorage } from "./storage/RedisUsersDepositsStorage";
import { UsersDepositsService } from "./services/UsersDepositsService";
import ClaimRequest from "./models/requests/ClaimRequest";
import SwapRequest from "./models/requests/SwapRequest";
import WithdrawalRequest from "./models/requests/WithdrawalRequest";
import config from "./config";
import { ClaimResponse } from "./models/responses/ClaimResponse";
import ProcessingQueue from "./services/queuing/ProcessingQueue";
import PendingWithdrawalsQueue from "./services/queuing/PendingWithdrawalsQueue";
import JobListener from "./services/queuing/JobListener";
import RedisProcessingQueue from "./services/queuing/RedisProcessingQueue";
import RedisPendingWithdrawalsQueue from "./services/queuing/RedisPendingWithdrawalsQueue";
import RepeatableQueue from "./services/queuing/RepeatableQueue";
import RedisRepeatableQueue from "./services/queuing/RedisRepeatableQueue";

const app: Application = express();
// const sse: SSE = new SSE();
const sseManager = new SSEManager();
const PORT = 3000;
const log: Logger = config.Logger.getChildLogger();

app.use(cors());
app.use(express.json());

const usersDepositsStorage: UsersDepositsStorage = new RedisUsersDepositsStorage();
const usersDepositsService: UsersDepositsService = new UsersDepositsService(
	usersDepositsStorage
);
const processingQueue: ProcessingQueue = new RedisProcessingQueue();
const pendingWithdrawalsQueue: PendingWithdrawalsQueue = new RedisPendingWithdrawalsQueue();
const repeatableQueue: RepeatableQueue = new RedisRepeatableQueue();
const svc = new Service(
	usersDepositsService,
	processingQueue,
	pendingWithdrawalsQueue,
	repeatableQueue
);
svc.start();

app.get("/health", (req: Request, res: Response) => {
	// TODO: check if connections to Banano node, BSC node and Redis node are okay!
	res.send({
		status: "OK",
	});
});

app.get("/deposits/ban/wallet", async (req: Request, res: Response) => {
	res.send({
		address: config.BananoUsersDepositsHotWallet,
	});
});

app.get("/deposits/ban/:ban_wallet", async (req: Request, res: Response) => {
	const banWallet = req.params.ban_wallet;
	const balance = await svc.getUserAvailableBalance(banWallet);
	res.send({
		balance: ethers.utils.formatEther(balance),
	});
});

app.post("/withdrawals/ban", async (req: Request, res: Response) => {
	// TODO: make sure all required parameters are sent!
	const withdrawalRequest: WithdrawalRequest = req.body as WithdrawalRequest;
	const banAmount: number = withdrawalRequest.amount;
	const banWallet: string = withdrawalRequest.ban;
	const bscWallet: string = withdrawalRequest.bsc;
	const signature: string = withdrawalRequest.sig;

	log.info(`Withdrawing ${banAmount} BAN to ${banWallet}`);

	await svc.withdrawBAN(
		banWallet,
		banAmount.toString(),
		bscWallet,
		new Date(),
		signature
	);
	res.status(201).send();
});

app.post("/claim", async (req: Request, res: Response) => {
	// TODO: make sure all required parameters are sent!
	const claimRequest: ClaimRequest = req.body as ClaimRequest;
	const { banAddress, bscAddress, sig } = claimRequest;
	log.info(
		`Check claim for ${banAddress} and ${bscAddress} with signature ${sig}`
	);
	const result: ClaimResponse = await svc.claim(banAddress, bscAddress, sig);
	switch (result) {
		case ClaimResponse.Ok:
			res.send({
				status: "OK",
			});
			break;
		case ClaimResponse.AlreadyDone:
			res.status(202).send({
				status: "Already done",
			});
			break;
		case ClaimResponse.InvalidOwner:
			res.status(409).send({
				message:
					"This BAN wallet was already claimed by another Binance Smart Chain Address.",
			});
			break;
		case ClaimResponse.InvalidSignature:
		case ClaimResponse.Error:
		default:
			res.status(409).send({
				message: "Invalid claim.",
			});
	}
});

app.post("/swap", async (req: Request, res: Response) => {
	// TODO: make sure all required parameters are sent!
	const swapRequest: SwapRequest = req.body as SwapRequest;
	const banAmount: number = swapRequest.amount;
	const banWallet: string = swapRequest.ban;
	const bscWallet: string = swapRequest.bsc;
	const signature: string = swapRequest.sig;

	log.debug(
		`banAmount=${banAmount}, banWallet=${banWallet}, bscWallet=${bscWallet}, signature=${signature}`
	);

	await svc.swapToWBAN(banWallet, banAmount, bscWallet, new Date(), signature);
	res.status(201).send();
});

/*
 * SERVER-SIDE EVENT MANAGEMENT
 */

app.set("sseManager", sseManager);

app.get("/events/:ban_wallet", async (req: Request, res: Response) => {
	const sse = req.app.get("sseManager");
	const id = req.params.ban_wallet;
	sse.open(id, res);
	req.on("close", () => {
		sse.delete(id);
	});
});

const jobListener: JobListener = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onJobCompleted(id: string, name: string, result: any): void {
		if (!result) {
			return;
		}
		log.warn(
			`Job ${name} with id ${id} completed with result ${JSON.stringify(
				result
			)}`
		);
		if (result.banWallet) {
			sseManager.unicast(result.banWallet, {
				id,
				type: name,
				data: result,
			});
		} else {
			sseManager.broadcast({
				id,
				type: name,
				data: result,
			});
		}
	},
};
processingQueue.addJobListener(jobListener);
pendingWithdrawalsQueue.addJobListener(jobListener);

app.listen(PORT, async () => {
	console.log(
		`⚡️[wBAN backend]: Server is running at http://localhost:${PORT}`
	);
});
