import { AxiosInstance } from "axios";
import { setup } from "axios-cache-adapter";
import { Logger } from "tslog";
import config from "../config";
import {
	PawWalletsBlacklist,
	BlacklistRecord,
} from "./PawWalletsBlacklist";

class KirbyPawWalletsBlacklist implements PawWalletsBlacklist {
	private api: AxiosInstance;

	private log: Logger = config.Logger.getChildLogger();

	constructor() {
		this.api = setup({
			cache: {
				maxAge: 60 * 60 * 1000,
			},
		});
	}

	async getBlacklistedWallets(): Promise<Array<BlacklistRecord>> {
		const resp = await this.api.get(
			"https://kirby.eu.pythonanywhere.com/api/v1/resources/addresses/all"
		);
		return resp.data as Array<BlacklistRecord>;
	}

	async isBlacklisted(pawWallet: string): Promise<BlacklistRecord | undefined> {
		const blacklist = await this.getBlacklistedWallets();
		const result = blacklist.find((record) => record.address === pawWallet);
		this.log.debug(
			`Blacklist check for "${pawWallet}": ${JSON.stringify(result)}`
		);
		return result;
	}
}

export default KirbyPawWalletsBlacklist;
