type BlacklistRecord = {
	address: string;
	alias: string;
	type: string;
};

interface PawWalletsBlacklist {
	getBlacklistedWallets(): Promise<Array<BlacklistRecord>>;
	/**
	 * Check if a PAW wallet/address is blacklisted.
	 * Returns a BlacklistRecord if address is blacklisted, undefined otherwise
	 * @param pawWallet the PAW wallet address to check with the blacklist
	 */
	isBlacklisted(pawWallet: string): Promise<BlacklistRecord | undefined>;
}

export { PawWalletsBlacklist, BlacklistRecord };
