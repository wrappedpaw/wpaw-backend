import * as dotenv from "dotenv";
import { Logger, TLogLevelName } from "tslog";

// dotenv.config();
let path;
switch (process.env.NODE_ENV) {
	case "test":
		path = ".env.test";
		break;
	case "testnet":
		path = ".env.testnet";
		break;
	case "mainnet":
		path = ".env.mainnet";
		break;
	default:
		path = ".env.local";
}
dotenv.config({ path });

const log: Logger = new Logger({
	name: "main",
	minLevel: process.env.LOG_LEVEL as TLogLevelName,
});

export default {
	PawUsersDepositsHotWallet:
		process.env.PAW_USERS_DEPOSITS_HOT_WALLET ?? "",
	PawUsersDepositsColdWallet:
		process.env.PAW_USERS_DEPOSITS_COLD_WALLET ?? "",
	PawSeed: process.env.PAW_SEED ?? "",
	PawSeedIdx: Number.parseInt(process.env.PAW_SEED_INDEX ?? "0", 10),
	PawRepresentative: process.env.PAW_REPRESENTATIVE ?? "",
	PawWebSocketsAPI: process.env.PAW_WS_API ?? "",
	PawRPCAPI: process.env.PAW_RPC_API ?? "",
	PawPendingTransactionsThreadEnabled:
		process.env.PAW_PENDING_TXN_THREAD ?? true,
	PawUsersDepositsHotWalletMinimum:
		process.env.PAW_USERS_DEPOSITS_HOT_WALLET_MIN ?? "0",
	PawUsersDepositsHotWalletToColdWalletRatio:
		process.env.PAW_USERS_DEPOSITS_HOT_WALLET_TO_COLD_WALLET_RATIO ?? "0.2",

	BlockchainJsonRpc: process.env.BC_JSON_RPC_URL ?? "",
	BlockchainBlockExplorerUrl: process.env.BC_BLOCK_EXPLORER_URL ?? "",
	BlockchainGasPriceTrackerApi: process.env.BC_GAS_TRACKER_API ?? "",
	BlockchainNetworkName: process.env.BC_NETWORK_NAME ?? "",
	BlockchainNetworkChainId: Number.parseInt(
		process.env.BC_NETWORK_CHAIN_ID ?? "0",
		10
	),
	BlockchainWalletMnemonic: process.env.BC_WALLET_MMENOMIC ?? "",
	BlockchainWalletMnemonicSignerIndex:
		process.env.BC_WALLET_MMENOMIC_SIGNER_INDEX ?? 0,
	BlockchainWalletPendingTransactionsThreadEnabled:
		process.env.BC_PENDING_TXN_THREAD ?? true,
	BlockchainWalletPendingTransactionsStartFromBlock: Number.parseInt(
		process.env.BC_PENDING_BLOCKS_START ?? "0",
		10
	),

	BlockchainDexTokensList: process.env.BC_DEX_TOKENS_LIST_URL ?? "",

	WPAWContractAddress: process.env.WPAW_CONTRACT_ADDRESS ?? "",

	RedisHost: process.env.REDIS_HOST ?? "",

	Logger: log,
};
