import { expect } from "chai";
import { PawWalletsBlacklist } from "../../src/services/PawWalletsBlacklist";
import KirbyPawWalletsBlacklist from "../../src/services/KirbyPawWalletsBlacklist";

describe("Paw Wallets Blacklist", () => {
	let svc: PawWalletsBlacklist = new KirbyPawWalletsBlacklist();

	it("Checks that CoinEx hot wallet is blacklisted", async () => {
		const coinex = await svc.isBlacklisted(
			"ban_1nrcne47secz1hnm9syepdoob7t1r4xrhdzih3zohb1c3z178edd7b6ygc4x"
		);
		expect(coinex).to.not.be.undefined;
		if (!coinex) {
			throw Error();
		}
		expect(coinex.alias).to.equal("CoinEx");
		expect(coinex.address).to.equal(
			"ban_1nrcne47secz1hnm9syepdoob7t1r4xrhdzih3zohb1c3z178edd7b6ygc4x"
		);
	});

	it("Checks that wPAW donations wallet is not blacklisted", async () => {
		expect(
			await svc.isBlacklisted(
				"ban_1wban1mwe1ywc7dtknaqdbog5g3ah333acmq8qxo5anibjqe4fqz9x3xz6ky"
			)
		).to.be.undefined;
	});
});
