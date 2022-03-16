import express, { Application, Request, Response } from "express";
import cors from "cors";
import { Logger } from "tslog";
import { ethers } from "ethers";
import SSEManager from "./services/sse/SSEManager";
import { Service } from "./services/Service";
import { TokensList } from "./services/TokensList";
import { BlockchainGasPriceTracker } from "./services/BlockchainGasPriceTracker";
import { UsersDepositsStorage } from "./storage/UsersDepositsStorage";
import { RedisUsersDepositsStorage } from "./storage/RedisUsersDepositsStorage";
import { UsersDepositsService } from "./services/UsersDepositsService";
import ClaimRequest from "./models/requests/ClaimRequest";
import SwapRequest from "./models/requests/SwapRequest";
import WithdrawalRequest from "./models/requests/WithdrawalRequest";
import config from "./config";
import { ClaimResponse } from "./models/responses/ClaimResponse";
import ProcessingQueue from "./services/queuing/ProcessingQueue";
import JobListener from "./services/queuing/JobListener";
import RedisProcessingQueue from "./services/queuing/RedisProcessingQueue";
import BlockchainScanQueue from "./services/queuing/BlockchainScanQueue";
import RedisBlockchainScanQueue from "./services/queuing/RedisBlockchainScanQueue";
import History from "./models/responses/History";
import { CoinExPricer } from "./prices/CoinExPricer";
import KirbyPawWalletsBlacklist from "./services/KirbyPawWalletsBlacklist";

const app: Application = express();
// const sse: SSE = new SSE();
const sseManager = new SSEManager();
const PORT = 3050;
const log: Logger = config.Logger.getChildLogger();

const corsWhitelist = [
	"https://bsc.paw.digital",
	"https://polygon.paw.digital",
	"https://fantom.paw.digital",
	"https://bsc-testnet.paw.digital",
	"https://polygon-testnet.paw.digital",
	"https://fantom-testnet.paw.digital",
	"http://localhost:8080",
	"http://213.239.194.182:8080"
];

app.use(
	cors({
		origin(origin, callback) {
			// allow requests with no origin
			if (!origin) return callback(null, true);
			if (corsWhitelist.indexOf(origin) === -1) {
				const message =
					"The CORS policy for this origin doesn't allow access from the particular origin.";
				return callback(new Error(message), false);
			}
			return callback(null, true);
		},
	})
);
app.use(express.json());

const usersDepositsStorage: UsersDepositsStorage = new RedisUsersDepositsStorage();
const usersDepositsService: UsersDepositsService = new UsersDepositsService(
	usersDepositsStorage
);
const processingQueue: ProcessingQueue = new RedisProcessingQueue();
const blockchainScanQueue: BlockchainScanQueue = new RedisBlockchainScanQueue(
	usersDepositsService
);
const gasPriceTracker = new BlockchainGasPriceTracker();
const tokensList = new TokensList();
const svc = new Service(
	usersDepositsService,
	processingQueue,
	blockchainScanQueue,
	new KirbyPawWalletsBlacklist()
);
svc.start();

app.get("/health", (req: Request, res: Response) => {
	// TODO: check if connections to Paw node, Blockchain node and Redis node are okay!
	res.send({
		status: "OK",
	});
});

app.get("/deposits/paw/wallet", async (req: Request, res: Response) => {
	res.send({
		address: config.PawUsersDepositsHotWallet,
	});
});

app.get("/deposits/paw/:paw_wallet", async (req: Request, res: Response) => {
	const pawWallet = req.params.paw_wallet;
	const balance = await svc.getUserAvailableBalance(pawWallet);
	res.send({
		balance: ethers.utils.formatEther(balance),
	});
});

app.post("/withdrawals/paw", async (req: Request, res: Response) => {
	// TODO: make sure all required parameters are sent!
	const withdrawalRequest: WithdrawalRequest = req.body as WithdrawalRequest;
	const pawAmount: number = withdrawalRequest.amount;
	const pawWallet: string = withdrawalRequest.paw;
	const blockchainWallet: string = withdrawalRequest.blockchain;
	const signature: string = withdrawalRequest.sig;

	log.info(`Withdrawing ${pawAmount} PAW to ${pawWallet}`);

	await svc.withdrawPAW(
		pawWallet,
		pawAmount.toString(),
		blockchainWallet,
		Date.now(),
		signature
	);
	res.status(201).send();
});

app.get("/withdrawals/pending", async (req: Request, res: Response) => {
	const balance = await svc.getPendingWithdrawalsAmount();
	res.send({
		amount: ethers.utils.formatEther(balance),
	});
});

app.post("/claim", async (req: Request, res: Response) => {
	// TODO: make sure all required parameters are sent!
	const claimRequest: ClaimRequest = req.body as ClaimRequest;
	const { pawAddress, blockchainAddress, sig } = claimRequest;
	log.info(
		`Check claim for ${pawAddress} and ${blockchainAddress} with signature ${sig}`
	);
	const result: ClaimResponse = await svc.claim(
		pawAddress,
		blockchainAddress,
		sig
	);
	switch (result) {
		case ClaimResponse.Ok:
			res.send({
				status: "OK",
			});
			break;
		case ClaimResponse.Blacklisted:
			res.status(403).send({
				message: "This PAW wallet is blacklisted.",
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
					"This PAW wallet was already claimed by another Blockchain Address.",
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
	const pawAmount: number = swapRequest.amount;
	const pawWallet: string = swapRequest.paw;
	const blockchainWallet: string = swapRequest.blockchain;
	const signature: string = swapRequest.sig;

	log.debug(
		`pawAmount=${pawAmount}, pawWallet=${pawWallet}, blockchainWallet=${blockchainWallet}, signature=${signature}`
	);

	await svc.swapToWPAW(
		pawWallet,
		pawAmount,
		blockchainWallet,
		Date.now(),
		signature
	);
	res.status(201).send();
});

app.get("/history/:blockchain/:paw", async (req: Request, res: Response) => {
	const blockchainWallet = req.params.blockchain;
	const pawWallet = req.params.paw;
	const history: History = await svc.getHistory(blockchainWallet, pawWallet);
	res.send(history);
});

app.get("/prices", async (req: Request, res: Response) => {
	const [
		pawPrice,
		bnbPrice,
		ethPrice,
		maticPrice,
		ftmPrice,
	] = await Promise.all([
		new CoinExPricer("PAWUSDT").getPriceInUSD(),
		new CoinExPricer("BNBUSDC").getPriceInUSD(),
		new CoinExPricer("ETHUSDC").getPriceInUSD(),
		new CoinExPricer("MATICUSDC").getPriceInUSD(),
		new CoinExPricer("FTMUSDC").getPriceInUSD(),
	]);
	res.send({
		paw: pawPrice,
		bnb: bnbPrice,
		eth: ethPrice,
		matic: maticPrice,
		ftm: ftmPrice,
	});
});

app.get("/blockchain/gas-price", async (req: Request, res: Response) => {
	res.type("json").send(await gasPriceTracker.getGasPriceTrackerData());
});

app.get("/dex/tokens", async (req: Request, res: Response) => {
	res.type("json").send(await tokensList.getTokensList());
});

/*
 * SERVER-SIDE EVENT MANAGEMENT
 */

app.set("sseManager", sseManager);
setInterval(
	() =>
		sseManager.broadcast({
			type: "ping",
			data: "ping",
		}),
	15_000
);

app.get("/events/:paw_wallet", async (req: Request, res: Response) => {
	const sse = req.app.get("sseManager");
	const id = req.params.paw_wallet;
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
		log.debug(
			`Job ${name} with id ${id} completed with result ${JSON.stringify(
				result
			)}`
		);
		if (result.pawWallet) {
			sseManager.unicast(result.pawWallet, {
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

app.listen(PORT, async () => {
	console.log(
		`⚡️[wPAW backend]: Server is running at http://localhost:${PORT}`
	);
});
