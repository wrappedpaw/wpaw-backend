import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as sinon from "ts-sinon";
import sinonChai from "sinon-chai";
import { UsersDepositsService } from "../src/services/UsersDepositsService";
import { Paw } from "../src/Paw";
import { BigNumber, ethers } from "ethers";
import ProcessingQueue from "../src/services/queuing/ProcessingQueue";
import config from "../src/config";
import { LockError } from "redlock";

const { expect } = chai;

chai.use(sinonChai);
chai.use(chaiAsPromised);

describe("Paw Service", () => {
	let svc: sinon.StubbedInstance<Paw>;
	let depositsService: sinon.StubbedInstance<UsersDepositsService>;
	let processingQueue: sinon.StubbedInstance<ProcessingQueue>;
	const seed = "012EZSFS";
	const seedIdx = 0;
	const representative = "paw_mycrazyrep";
	const hotWallet = "paw_CAFEBABE";
	const coldWallet = "paw_ILIKETHIS";

	beforeEach(async () => {
		depositsService = sinon.stubInterface<UsersDepositsService>();
		processingQueue = sinon.stubInterface<ProcessingQueue>();
		const paw = new Paw(
			hotWallet,
			coldWallet,
			seed,
			seedIdx,
			representative,
			depositsService,
			processingQueue
		);
		svc = sinon.stubObject<Paw>(paw, [
			"receiveTransaction",
			"sendPaw",
			"getTotalBalance",
		]);
	});

	describe("Users Deposits", () => {
		it("Sends back deposited PAW from a wallet not claimed", async () => {
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther("1");
			const hash = "0xCAFEBABE";
			depositsService.hasPendingClaim.withArgs(sender).resolves(false);
			depositsService.isClaimed.withArgs(sender).resolves(false);

			svc.receiveTransaction.resolves();
			svc.sendPaw.resolves("0xTHISROCKS");

			// make a deposit
			await svc.processUserDeposit(sender, amount, Date.now(), hash);

			// expect for it to be received
			expect(svc.receiveTransaction).to.be.calledOnce;
			// and sent back
			expect(svc.sendPaw).to.be.calledOnceWith(sender, amount);
		});

		it("Sends back PAW deposits with more than two decimals", async () => {
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther("1.466");
			const hash = "0xCAFEBABE";
			depositsService.hasPendingClaim.withArgs(sender).resolves(false);
			depositsService.isClaimed.withArgs(sender).resolves(true);

			svc.receiveTransaction.resolves();
			svc.sendPaw.resolves("0xTHISROCKS");

			// make a deposit
			await svc.processUserDeposit(sender, amount, Date.now(), hash);

			// expect for it to be received
			expect(svc.receiveTransaction).to.be.calledOnce;
			// and sent back
			expect(svc.sendPaw).to.be.calledOnceWith(sender, amount);
			// and have no deposit stored
			expect(depositsService.storeUserDeposit).to.not.have.been.called;
		});

		it("Fails if there is a redlock error", async () => {
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther("1");
			const hash = "0xCAFEBABE";
			const timestamp = Date.now();
			depositsService.hasPendingClaim.withArgs(sender).resolves(true);
			depositsService.confirmClaim.withArgs(sender).resolves(true);
			depositsService.isClaimed.withArgs(sender).resolves(true);
			depositsService.storeUserDeposit
				.withArgs(sender, amount, timestamp, hash)
				.throws(new LockError("Exceeded 10 attempts to lock the resource"));

			svc.receiveTransaction.resolves();
			svc.getTotalBalance
				.withArgs(hotWallet)
				.resolves(ethers.utils.parseEther("1"))
				.withArgs(coldWallet)
				.resolves(ethers.utils.parseEther("1"));

			// make a deposit expected to fail
			expect(
				svc.processUserDeposit(sender, amount, timestamp, hash)
			).to.be.rejectedWith(
				new LockError("Exceeded 10 attempts to lock the resource")
			);
		});

		it("Registers user deposit from a pending claimed wallet", async () => {
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther("1");
			const hash = "0xCAFEBABE";
			const timestamp = Date.now();
			depositsService.hasPendingClaim.withArgs(sender).resolves(true);
			depositsService.confirmClaim.withArgs(sender).resolves(true);
			depositsService.isClaimed.withArgs(sender).resolves(true);
			depositsService.storeUserDeposit
				.withArgs(sender, amount, timestamp, hash)
				.resolves();

			svc.receiveTransaction.resolves();
			svc.getTotalBalance
				.withArgs(hotWallet)
				.resolves(ethers.utils.parseEther("1"))
				.withArgs(coldWallet)
				.resolves(ethers.utils.parseEther("1"));

			// make a deposit
			await svc.processUserDeposit(sender, amount, timestamp, hash);

			// expect for it to be received
			expect(svc.receiveTransaction).to.be.calledOnce;
			// and stored
			expect(depositsService.storeUserDeposit).to.be.calledOnceWith(
				sender,
				amount,
				timestamp,
				hash
			);
		});
	});

	describe("Users Deposits hot/cold wallets", () => {
		let dataset = [
			{
				hot: config.PawUsersDepositsHotWalletMinimum,
				deposit: "10",
				expected: "8.0",
			},
			{ hot: "5", deposit: "12", expected: "5.6" },
			{ hot: "0", deposit: "11", expected: "0.8" },
			{ hot: "20", deposit: "10", expected: "8.0" },
			{
				hot: config.PawUsersDepositsHotWalletMinimum,
				deposit: "4.12",
				expected: "3.2",
			},
		];

		dataset.forEach(({ hot, deposit, expected }) => {
			it(`Send ${expected} PAW to cold wallet when hot wallet has ${hot} PAW and user made a deposit of ${deposit} PAW`, async () => {
				const sender = "paw_sender";
				const amount: BigNumber = ethers.utils.parseEther(deposit);
				const timestamp = Date.now();
				const hash = "0xCAFEBABE";
				depositsService.hasPendingClaim.withArgs(sender).resolves(true);
				depositsService.confirmClaim.withArgs(sender).resolves(true);
				depositsService.isClaimed.withArgs(sender).resolves(true);
				depositsService.storeUserDeposit
					.withArgs(sender, amount, timestamp, hash)
					.resolves();

				svc.receiveTransaction.resolves();
				svc.getTotalBalance
					.withArgs(hotWallet)
					.resolves(ethers.utils.parseEther(hot).add(amount));
				svc.sendPaw.resolves("0xTHISROCKS");

				// make a deposit
				await svc.processUserDeposit(sender, amount, timestamp, hash);

				// expect for it to be received
				expect(svc.receiveTransaction).to.be.calledOnce;
				// and stored
				expect(depositsService.storeUserDeposit).to.be.calledOnceWith(
					sender,
					amount,
					timestamp,
					hash
				);
				// and PAW to be sent to cold wallet
				expect(svc.sendPaw).to.be.calledOnceWith(
					coldWallet,
					ethers.utils.parseEther(expected)
				);
			});
		});

		it("Don't send PAW to cold wallet if there is not enough PAW in hot wallet", async () => {
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther("4");
			const timestamp = Date.now();
			const hash = "0xCAFEBABE";
			depositsService.hasPendingClaim.withArgs(sender).resolves(true);
			depositsService.confirmClaim.withArgs(sender).resolves(true);
			depositsService.isClaimed.withArgs(sender).resolves(true);
			depositsService.storeUserDeposit
				.withArgs(sender, amount, timestamp, hash)
				.resolves();

			svc.receiveTransaction.resolves();
			svc.getTotalBalance
				.withArgs(hotWallet)
				.resolves(
					ethers.utils
						.parseEther(config.PawUsersDepositsHotWalletMinimum)
						.sub(amount.add(ethers.utils.parseEther("1")))
				);
			// svc.sendPaw.resolves("0xTHISROCKS");

			// make a deposit
			await svc.processUserDeposit(sender, amount, timestamp, hash);

			// expect for it to be received
			expect(svc.receiveTransaction).to.be.calledOnce;
			// and stored
			expect(depositsService.storeUserDeposit).to.be.calledOnceWith(
				sender,
				amount,
				timestamp,
				hash
			);
			// and no PAW to be sent to cold wallet
			expect(svc.sendPaw).to.not.have.been.called;
		});

		it("Don't send PAW to cold wallet if there is 0 PAW to send", async () => {
			const hot = config.PawUsersDepositsHotWalletMinimum;
			const deposit = "0.01";
			const sender = "paw_sender";
			const amount: BigNumber = ethers.utils.parseEther(deposit);
			const timestamp = Date.now();
			const hash = "0xCAFEBABE";
			depositsService.hasPendingClaim.withArgs(sender).resolves(true);
			depositsService.confirmClaim.withArgs(sender).resolves(true);
			depositsService.isClaimed.withArgs(sender).resolves(true);
			depositsService.storeUserDeposit
				.withArgs(sender, amount, timestamp, hash)
				.resolves();

			svc.receiveTransaction.resolves();
			svc.getTotalBalance
				.withArgs(hotWallet)
				.resolves(ethers.utils.parseEther(hot).add(amount));
			svc.sendPaw.resolves("0xTHISROCKS");

			// make a deposit
			await svc.processUserDeposit(sender, amount, timestamp, hash);

			// expect for it to be received
			expect(svc.receiveTransaction).to.be.calledOnce;
			// and stored
			expect(depositsService.storeUserDeposit).to.be.calledOnceWith(
				sender,
				amount,
				timestamp,
				hash
			);
			// and no PAW to be sent to cold wallet
			expect(svc.sendPaw).to.not.have.been.called;
		});
	});
});
