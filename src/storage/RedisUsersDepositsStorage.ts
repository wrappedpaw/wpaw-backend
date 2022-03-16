import { Logger } from "tslog";
import IORedis from "ioredis";
import Redlock from "redlock";
import { BigNumber, ethers } from "ethers";
import { UsersDepositsStorage } from "./UsersDepositsStorage";
import SwapWPAWToPaw from "../models/operations/SwapWPAWToPaw";
import config from "../config";

/**
 * Redis storage explanations:
 * - `paw-balance`: map whose key is the PAW address and whose value is the PAW balance as a big number
 * - `deposits:${paw_address}`: sorted set (by timestamp) of all PAW deposits transactions hash
 * - `withdrawals:${paw_address}`: sorted set (by timestamp) of all PAW withdrawals TODO: date vs hash issue
 * - `swaps:paw-to-wpaw:${paw_address}`: sorted set (by timestamp) of all PAW -> wPAW receipts generated
 * - `swaps:wpaw-to-paw:${blockchain_address}`: sorted set (by timestamp) of all wPAW -> PAW transactions hash
 * - `audit:${hash|receipt}`: map of all the data associated to the event (deposit/withdrawal/swap)
 * - `claims:pending:${paw_address}:${blockchain_address}`: value of 1 means a pending claim -- expires after 5 minutes (TTL)
 * - `claims:${paw_address}:${blockchain_address}`: value of 1 means a valid claim
 */
class RedisUsersDepositsStorage implements UsersDepositsStorage {
	private redis: IORedis.Redis;

	private redlock: Redlock;

	private log: Logger = config.Logger.getChildLogger();

	private static LIMIT = 1000;

	constructor() {
		this.redis = new IORedis({ host: config.RedisHost });
		this.redlock = new Redlock([this.redis], {
			// the expected clock drift; for more details
			// see http://redis.io/topics/distlock
			driftFactor: 0.01, // multiplied by lock ttl to determine drift time
			// the max number of times Redlock will attempt
			// to lock a resource before erroring
			retryCount: 10,
			// the time in ms between attempts
			retryDelay: 200, // time in ms
			// the max time in ms randomly added to retries
			// to improve performance under high contention
			// see https://www.awsarchitectureblog.com/2015/03/backoff.html
			retryJitter: 200, // time in ms
		});
	}

	async getUserAvailableBalance(from: string): Promise<BigNumber> {
		return this.redlock
			.lock(`locks:paw-balance:${from}`, 1_000)
			.then(async (lock) => {
				const rawAmount: string | null = await this.redis.get(
					`paw-balance:${from.toLowerCase()}`
				);
				if (rawAmount === null) {
					return BigNumber.from(0);
				}
				// unlock resource when done
				await lock.unlock().catch((err) => this.log.error(err));
				return BigNumber.from(rawAmount);
			});
	}

	/*
	async lockBalance(from: string): Promise<void> {
		this.redis.set(`locks:paw-balance:${from.toLowerCase()}`, "1");
	}

	async unlockBalance(from: string): Promise<void> {
		this.redis.del(`locks:paw-balance:${from.toLowerCase()}`);
	}

	async isBalanceLocked(from: string): Promise<boolean> {
		return (
			(await this.redis.exists(`locks:paw-balance:${from.toLowerCase()}`)) === 1
		);
	}
	*/

	async hasPendingClaim(pawAddress: string): Promise<boolean> {
		const pendingClaims = await this.redis.keys(
			`claims:pending:${pawAddress.toLowerCase()}:*`
		);
		const exists = pendingClaims.length > 0;
		this.log.debug(
			`Checked if there is already a pending claim for ${pawAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async storePendingClaim(
		pawAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		try {
			const key = `claims:pending:${pawAddress.toLowerCase()}:${blockchainAddress.toLowerCase()}`;
			await this.redis
				.multi()
				.set(key, "1")
				.expire(key, 5 * 60) // 5 minutes
				.exec();
			this.log.info(
				`Stored pending claim for ${
					pawAddress.toLowerCase
				} and ${blockchainAddress.toLowerCase()}`
			);
			return true;
		} catch (err) {
			this.log.error(err);
			return false;
		}
	}

	async isClaimed(pawAddress: string): Promise<boolean> {
		const claims = await this.redis.keys(
			`claims:${pawAddress.toLowerCase()}:*`
		);
		const exists = claims.length > 0;
		this.log.trace(
			`Checked if there is a claim for ${pawAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async hasClaim(
		pawAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		const pendingClaims = await this.redis.keys(
			`claims:${pawAddress.toLowerCase()}:${blockchainAddress.toLowerCase()}`
		);
		const exists = pendingClaims.length > 0;
		this.log.trace(
			`Checked if there is a claim for ${pawAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async confirmClaim(pawAddress: string): Promise<boolean> {
		const pendingClaims = await this.redis.keys(
			`claims:pending:${pawAddress.toLowerCase()}:*`
		);
		const key = pendingClaims[0].replace(":pending", "");
		await this.redis.set(key, 1);
		this.log.info(`Stored claim for ${pawAddress} with ${key}`);
		return true;
	}

	async storeUserDeposit(
		_pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		const pawAddress = _pawAddress.toLowerCase();
		this.log.info(
			`Storing user deposit from: ${pawAddress}, amount: ${amount} PAW, hash: ${hash}`
		);
		this.redlock
			.lock(`locks:paw-balance:${pawAddress}`, 30_000)
			.then(async (lock) => {
				let rawBalance: string | null;
				try {
					rawBalance = await this.redis.get(`paw-balance:${pawAddress}`);
					let balance: BigNumber;
					if (rawBalance) {
						balance = BigNumber.from(rawBalance);
					} else {
						balance = BigNumber.from(0);
					}
					balance = balance.add(amount);

					await this.redis
						.multi()
						.set(`paw-balance:${pawAddress}`, balance.toString())
						.zadd(`deposits:${pawAddress}`, timestamp, hash)
						.hset(`audit:${hash}`, { type: "deposit", hash, amount, timestamp })
						.exec();
					this.log.info(
						`Stored user deposit from: ${pawAddress}, amount: ${ethers.utils.formatEther(
							amount
						)} PAW, hash: ${hash}`
					);
				} catch (err) {
					this.log.error(err);
				}

				// unlock resource when done
				return lock.unlock().catch((err) => this.log.error(err));
			})
			.catch((err) => {
				this.log.error(
					`Couldn't store user deposit from: ${pawAddress}, amount: ${ethers.utils.formatEther(
						amount
					)} PAW, hash: ${hash}`
				);
				throw err;
			});
	}

	async containsUserDepositTransaction(
		pawAddress: string,
		hash: string
	): Promise<boolean> {
		this.log.info(
			`Checking if user deposit transaction from ${pawAddress.toLowerCase()} with hash ${hash} was already processed...`
		);
		const isAlreadyStored: number | null = await this.redis.zrank(
			`deposits:${pawAddress.toLowerCase()}`,
			hash
		);
		return isAlreadyStored != null;
	}

	async storeUserWithdrawal(
		_pawAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		const pawAddress = _pawAddress.toLowerCase();
		this.log.info(
			`Storing user withdrawal to: ${pawAddress}, amount: ${ethers.utils.formatEther(
				amount
			)} PAW, hash: ${hash}`
		);
		this.redlock
			.lock(`locks:paw-balance:${pawAddress}`, 1_000)
			.then(async (lock) => {
				let rawBalance: string | null;
				try {
					rawBalance = await this.redis.get(`paw-balance:${pawAddress}`);
					let balance: BigNumber;
					if (rawBalance) {
						balance = BigNumber.from(rawBalance);
					} else {
						balance = BigNumber.from(0);
					}
					balance = balance.sub(amount);

					await this.redis
						.multi()
						.set(`paw-balance:${pawAddress}`, balance.toString())
						.zadd(`withdrawals:${pawAddress}`, timestamp, hash)
						.hset(`audit:${hash}`, {
							type: "withdrawal",
							hash,
							amount,
							timestamp,
						})
						.exec();
					this.log.info(
						`Stored user withdrawal from: ${pawAddress}, amount: ${ethers.utils.formatEther(
							amount
						)} PAW`
					);
				} catch (err) {
					this.log.error(err);
				}
				// unlock resource when done
				return lock.unlock().catch((err) => this.log.error(err));
			})
			.catch((err) => {
				throw err;
			});
	}

	async containsUserWithdrawalRequest(
		pawAddress: string,
		timestamp: number
	): Promise<boolean> {
		this.log.info(
			`Checking if user withdrawal request from ${pawAddress.toLowerCase()} at ${timestamp} was already processed...`
		);
		const isAlreadyStored = await this.redis.zcount(
			`withdrawals:${pawAddress.toLowerCase()}`,
			timestamp,
			timestamp
		);
		return isAlreadyStored === 1;
	}

	async storeUserSwapToWPaw(
		_pawAddress: string,
		_blockchainAddress: string,
		amount: BigNumber,
		timestamp: number,
		receipt: string,
		uuid: string
	): Promise<void> {
		if (!_pawAddress) {
			throw new Error("Missing PAW address");
		}
		const pawAddress = _pawAddress.toLowerCase();
		this.log.info(
			`Storing swap of ${ethers.utils.formatEther(
				amount
			)} PAW for user ${pawAddress}`
		);
		await this.redlock
			.lock(`locks:swaps:paw-to-wpaw:${pawAddress}`, 1_000)
			.then(async (lock: Redlock.Lock) => {
				try {
					const balance = (await this.getUserAvailableBalance(pawAddress)).sub(
						amount
					);
					await this.redis
						.multi()
						.set(`paw-balance:${pawAddress}`, balance.toString())
						.zadd(`swaps:paw-to-wpaw:${pawAddress}`, timestamp, receipt)
						.hset(`audit:${receipt}`, {
							type: "swap-to-wpaw",
							blockchainAddress: _blockchainAddress.toLowerCase(),
							receipt,
							uuid,
							amount,
							timestamp,
						})
						.exec();
					this.log.info(
						`Stored user swap from: ${pawAddress}, amount: ${ethers.utils.formatEther(
							amount
						)} PAW, receipt: ${receipt}`
					);
				} catch (err) {
					this.log.error(err);
				}

				// unlock resource when done
				return lock.unlock().catch((err) => this.log.error(err));
			})
			.catch((err) => {
				throw err;
			});
	}

	async storeUserSwapToPaw(swap: SwapWPAWToPaw): Promise<void> {
		if (!swap.pawWallet) {
			throw new Error("Missing PAW address");
		}
		this.redlock
			.lock(`locks:paw-balance:${swap.pawWallet}`, 1_000)
			.then(async (lock) => {
				// check "again" if the txn wasn't already processed
				if (await this.swapToPawWasAlreadyDone(swap)) {
					this.log.warn(
						`Swap for transaction "${swap.hash}" was already done.`
					);
				} else {
					let rawBalance: string | null;
					try {
						rawBalance = await this.redis.get(
							`paw-balance:${swap.pawWallet.toLowerCase()}`
						);
						let balance: BigNumber;
						if (rawBalance) {
							balance = BigNumber.from(rawBalance);
						} else {
							balance = BigNumber.from(0);
						}
						balance = balance.add(ethers.utils.parseEther(swap.amount));

						await this.redis
							.multi()
							.set(
								`paw-balance:${swap.pawWallet.toLowerCase()}`,
								balance.toString()
							)
							.zadd(
								`swaps:wpaw-to-paw:${swap.blockchainWallet.toLowerCase()}`,
								swap.timestamp * 1_000,
								swap.hash
							)
							.hset(`audit:${swap.hash}`, {
								type: "swap-to-paw",
								hash: swap.hash,
								pawAddress: swap.pawWallet.toLowerCase(),
								amount: ethers.utils.parseEther(swap.amount).toString(),
								timestamp: swap.timestamp * 1_000,
							})
							.exec();
						this.log.info(
							`Stored user swap from wPAW of ${
								swap.amount
							} PAW from ${swap.blockchainWallet.toLowerCase()} to ${swap.pawWallet.toLowerCase()} with hash: ${
								swap.hash
							}`
						);
					} catch (err) {
						this.log.error(err);
					}
				}
				// unlock resource when done
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return lock.unlock().catch((err: any) => this.log.error(err));
			})
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.catch((err: any) => {
				throw err;
			});
	}

	async swapToPawWasAlreadyDone(swap: SwapWPAWToPaw): Promise<boolean> {
		this.log.info(
			`Checking if swap from ${swap.blockchainWallet.toLowerCase()} with hash ${
				swap.hash
			} was already processed...`
		);
		const isAlreadyProcessed: number | null = await this.redis.zrank(
			`swaps:wpaw-to-paw:${swap.blockchainWallet.toLowerCase()}`,
			swap.hash
		);
		return isAlreadyProcessed != null;
	}

	async getLastBlockchainBlockProcessed(): Promise<number> {
		const rawBlockValue = await this.redis.get("blockchain:blocks:latest");
		if (rawBlockValue === null) {
			return config.BlockchainWalletPendingTransactionsStartFromBlock;
		}
		return Number.parseInt(rawBlockValue, 10);
	}

	async setLastBlockchainBlockProcessed(block: number): Promise<void> {
		const lastBlockProcessed = await this.getLastBlockchainBlockProcessed();
		if (block > lastBlockProcessed) {
			this.redis.set("blockchain:blocks:latest", block.toString());
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getDeposits(pawAddress: string): Promise<Array<any>> {
		const hashes: string[] = await this.redis.zrevrangebyscore(
			`deposits:${pawAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			hashes.map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				results.link = `https://tracker.paw.digital/block/${hash}`;
				return results;
			})
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getWithdrawals(pawAddress: string): Promise<Array<any>> {
		const hashes: string[] = await this.redis.zrevrangebyscore(
			`withdrawals:${pawAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			hashes.map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				results.link = `https://tracker.paw.digital/block/${hash}`;
				return results;
			})
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getSwaps(
		blockchainAddress: string,
		pawAddress: string
	): Promise<Array<any>> {
		const pawToWPAW: string[] = await this.redis.zrevrangebyscore(
			`swaps:paw-to-wpaw:${pawAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		const wpawToPAW: string[] = await this.redis.zrevrangebyscore(
			`swaps:wpaw-to-paw:${blockchainAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			pawToWPAW.concat(wpawToPAW).map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				if (results.type === "swap-to-paw") {
					results.link = `${config.BlockchainBlockExplorerUrl}/tx/${hash}`;
				}
				return results;
			})
		);
	}
}

export { RedisUsersDepositsStorage };
