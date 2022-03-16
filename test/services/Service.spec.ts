import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as sinon from "ts-sinon";
import sinonChai from "sinon-chai";
import { UsersDepositsService } from "../../src/services/UsersDepositsService";
import { Service } from "../../src/services/Service";
import { ClaimResponse } from "../../src/models/responses/ClaimResponse";
import { BigNumber, ethers } from "ethers";
import { Blockchain } from "../../src/Blockchain";
import InvalidOwner from "../../src/errors/InvalidOwner";
import InvalidSignatureError from "../../src/errors/InvalidSignatureError";
import { Paw } from "../../src/Paw";
import ProcessingQueue from "../../src/services/queuing/ProcessingQueue";
import BlockchainScanQueue from "../../src/services/queuing/BlockchainScanQueue";
import PawUserWithdrawal from "../../src/models/operations/PawUserWithdrawal";
import config from "../../src/config";
import KirbyPawWalletsBlacklist from "../../src/services/KirbyPawWalletsBlacklist";
import { PawWalletsBlacklist } from "../../src/services/PawWalletsBlacklist";

const { expect } = chai;
chai.use(sinonChai);
chai.use(chaiAsPromised);

describe("Main Service", () => {
	let svc: Service;
	let depositsService: sinon.StubbedInstance<UsersDepositsService>;
	let processingQueue: sinon.StubbedInstance<ProcessingQueue>;
	let blockchainScanQueue: sinon.StubbedInstance<BlockchainScanQueue>;
	let blockchain: sinon.StubbedInstance<Blockchain>;
	let paw: sinon.StubbedInstance<Paw>;
	let pawWalletsBlacklist: sinon.StubbedInstance<PawWalletsBlacklist>;

	beforeEach(async () => {
		depositsService = sinon.stubInterface<UsersDepositsService>();
		processingQueue = sinon.stubInterface<ProcessingQueue>();
		blockchainScanQueue = sinon.stubInterface<BlockchainScanQueue>();
		blockchain = sinon.stubInterface<Blockchain>();
		paw = sinon.stubInterface<Paw>();
		pawWalletsBlacklist = sinon.stubInterface<PawWalletsBlacklist>();
		svc = new Service(
			depositsService,
			processingQueue,
			blockchainScanQueue,
			pawWalletsBlacklist
		);
		svc.blockchain = blockchain;
		svc.paw = paw;
	});

	it("Checks properly signatures", async () => {
		const amount = "29.0";
		const from =
			"ban_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
		const blockchainWallet = "0x69FD25B60Da76Afd10D8Fc7306f10f2934fC4829";
		const signature =
			"0x8b828450dbc98d25c13443f91338863bb319266d3d9e92fdf5e1eb4d9b241b85704dcabe560382790435510b33b2990057d3325fb992e9f29b5c9ffede6b5e121c";
		const badSignature =
			"0x8b828450dbc98d25c13443f91338863bb319266d3d9e92fdf5e1eb4d9b241b85704dcabe560382790435510b33b2990057d3325fb992e9f29b5c9ffede6b5e121b";

		expect(
			svc.checkSignature(
				blockchainWallet,
				signature,
				`Swap ${amount} BAN for wBAN with BAN I deposited from my wallet "${from}"`
			)
		).to.be.true;

		expect(
			svc.checkSignature(
				"0x59fd25b60da76afd10d8fc7306f10f2934fc4828",
				signature,
				`Swap ${amount} BAN for wBAN with BAN I deposited from my wallet "${from}"`
			)
		).to.be.false;

		await expect(
			svc.processSwapToWPAW({
				from,
				amount: 10,
				blockchainWallet,
				timestamp: Date.now(),
				signature: badSignature,
			})
		).to.eventually.be.rejectedWith(InvalidSignatureError);
	});

	describe("Claims for PAW wallet", () => {
		it("Checks that a PAW wallet can't be claimed multiple times by the same Blockchain user", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			const blockchainWallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
			const signature =
				"0x2edce56eb0980a3473ec39d273502b25c5e3496b400d953dd4041bfe287b37b637331be1f386e011b7c607dd352209564746984f845566b16b23fa059b0f12bb1b";

			pawWalletsBlacklist.isBlacklisted.resolves(undefined);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet)
				.onFirstCall()
				.resolves(false)
				.onSecondCall()
				.resolves(true);
			depositsService.hasPendingClaim
				.withArgs(pawWallet)
				.onFirstCall()
				.resolves(false)
				.onSecondCall()
				.resolves(true);
			depositsService.storePendingClaim
				.withArgs(pawWallet, blockchainWallet)
				.returns(Promise.resolve(true));

			expect(await svc.claim(pawWallet, blockchainWallet, signature)).to.equal(
				ClaimResponse.Ok
			);
			expect(await svc.claim(pawWallet, blockchainWallet, signature)).to.equal(
				ClaimResponse.AlreadyDone
			);
			expect(depositsService.storePendingClaim).to.have.been.calledOnce;
		});

		it("Checks that a PAW wallet can't be claimed by two different users", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			
			const blockchainWallet1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
			const signature1 =
				"0x2edce56eb0980a3473ec39d273502b25c5e3496b400d953dd4041bfe287b37b637331be1f386e011b7c607dd352209564746984f845566b16b23fa059b0f12bb1b";

			const blockchainWallet2 = "0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1";
			const signature2 =
				"0xf702b3dd369ed37c0ae626a73ac3945c24aa7781a43385560a554bc0e3e1f4123d46579354fa2364e58f8acb362799279f20c40c8feb772cfa148f8310b8931f1b";

			pawWalletsBlacklist.isBlacklisted.resolves(undefined);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet1)
				.resolves(false)
				.withArgs(pawWallet, blockchainWallet2)
				.resolves(false);
			depositsService.hasPendingClaim
				.withArgs(pawWallet)
				.onFirstCall()
				.resolves(false)
				.onSecondCall()
				.resolves(true);
			depositsService.storePendingClaim
				.withArgs(pawWallet, blockchainWallet1)
				.returns(Promise.resolve(true));

			expect(
				await svc.claim(pawWallet, blockchainWallet1, signature1)
			).to.equal(ClaimResponse.Ok);

			expect(
				await svc.claim(pawWallet, blockchainWallet2, signature2)
			).to.equal(ClaimResponse.InvalidOwner);

			expect(depositsService.storePendingClaim).to.have.been.calledOnce;
		});

		it("Checks that a blacklisted PAW wallet can't be claimed", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			const blockchainWallet = "0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1";
			const signature =
				"0xf702b3dd369ed37c0ae626a73ac3945c24aa7781a43385560a554bc0e3e1f4123d46579354fa2364e58f8acb362799279f20c40c8feb772cfa148f8310b8931f1b";
			
			pawWalletsBlacklist.isBlacklisted
				.withArgs(pawWallet)
				.resolves({ address: pawWallet, alias: "CoinEx", type: "" });
			expect(await svc.claim(pawWallet, blockchainWallet, signature)).to.equal(
				ClaimResponse.Blacklisted
			);
			expect(depositsService.storePendingClaim).to.not.have.been.called;
		});
	});

	describe("Withdrawals", () => {
		it("Checks if a negative withdrawal amount is rejected", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			const blockchainWallet = "0xec410E9F2756C30bE4682a7E29918082Adc12B55";
			const withdrawal: PawUserWithdrawal = {
				pawWallet,
				amount: "-5",
				blockchainWallet,
				signature:
					"0xc7f21062ef2c672e8cc77cecfdf532f39bcf6791e7f41266491fe649bedeaec9443e963400882d6dc46c8e10c033528a7bc5a517e136296d01be339baf6e9efb1b",
				timestamp: Date.now(),
				attempt: 0,
			};
			depositsService.containsUserWithdrawalRequest
				.withArgs(withdrawal)
				.onFirstCall()
				.resolves(false);
			depositsService.isClaimed.withArgs(pawWallet).resolves(true);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet)
				.resolves(true);
			depositsService.getUserAvailableBalance
				.withArgs(pawWallet)
				.resolves(ethers.utils.parseEther("200"));
			paw.getBalance
				.withArgs(config.PawUsersDepositsHotWallet)
				.resolves(ethers.utils.parseEther("100"));
			// make the withdrawal...
			await expect(
				svc.processWithdrawPAW(withdrawal)
			).to.eventually.be.rejectedWith("Can't withdraw negative amounts of PAW");
			// ... and that no withdrawal was processed
			expect(paw.sendPaw).to.have.not.been.called;
			expect(depositsService.storeUserWithdrawal).to.have.not.been.called;
		});

		it("Checks if a big withdrawal is put in pending withdrawals", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			const blockchainWallet = "0xec410E9F2756C30bE4682a7E29918082Adc12B55";
			const withdrawal: PawUserWithdrawal = {
				pawWallet,
				amount: "150",
				blockchainWallet,
				signature:
					"0xc7f21062ef2c672e8cc77cecfdf532f39bcf6791e7f41266491fe649bedeaec9443e963400882d6dc46c8e10c033528a7bc5a517e136296d01be339baf6e9efb1b",
				timestamp: Date.now(),
				attempt: 0,
			};
			depositsService.containsUserWithdrawalRequest
				.withArgs(withdrawal)
				.onFirstCall()
				.resolves(false);
			depositsService.isClaimed.withArgs(pawWallet).resolves(true);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet)
				.resolves(true);
			depositsService.getUserAvailableBalance
				.withArgs(pawWallet)
				.resolves(ethers.utils.parseEther("200"));
			paw.getBalance
				.withArgs(config.PawUsersDepositsHotWallet)
				.resolves(ethers.utils.parseEther("100"));
			// make the withdrawal...
			await svc.processWithdrawPAW(withdrawal);
			// ... expect it to be added to the pending withdrawals queue
			expect(processingQueue.addPawUserPendingWithdrawal).to.have.been
				.calledOnce;
			// ... and that no withdrawal was processed
			expect(paw.sendPaw).to.have.not.been.called;
			expect(depositsService.storeUserWithdrawal).to.have.not.been.called;
		});
	});

	describe("Swaps PAW->wPAW", () => {
		it("Checks that a swap can't be done with negative PAW amount", async () => {
			const availableBalance = ethers.utils.parseEther("10");

			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";

			const blockchainWallet = "0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1";
			const signature =
				"0x3d25329321cb9878a264d1230518f90bae5815c32fa7f79452d5b64cb0ae63dc539dc27f2b041809422d3f51c8868d2466149afc3266c6d91cd1a24dc80c46c71b";
			
			depositsService.getUserAvailableBalance
				.withArgs(pawWallet)
				.resolves(availableBalance);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet)
				.resolves(true);

			await expect(
				svc.processSwapToWPAW({
					from: pawWallet,
					amount: -1,
					blockchainWallet: blockchainWallet,
					timestamp: Date.now(),
					signature: signature,
				})
			).to.eventually.be.rejectedWith("Can't swap negative amounts of PAW");
			expect(blockchain.createMintReceipt).to.not.have.been.called;
		});
	});

	describe("Idempotence", () => {
		it("Checks if a user withdrawal request is not processed twice", async () => {
			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";
			const blockchainWallet = "0xec410E9F2756C30bE4682a7E29918082Adc12B55";
			const withdrawal: PawUserWithdrawal = {
				pawWallet,
				amount: "150",
				blockchainWallet,
				signature:
					"0xc7f21062ef2c672e8cc77cecfdf532f39bcf6791e7f41266491fe649bedeaec9443e963400882d6dc46c8e10c033528a7bc5a517e136296d01be339baf6e9efb1b",
				timestamp: Date.now(),
				attempt: 0,
			};
			depositsService.containsUserWithdrawalRequest
				.withArgs(withdrawal)
				// accept to ingest the transaction the first time
				.onFirstCall()
				.resolves(false)
				// reject it the second time
				.onSecondCall()
				.resolves(true);
			depositsService.isClaimed.withArgs(pawWallet).resolves(true);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet)
				.resolves(true);
			depositsService.getUserAvailableBalance
				.withArgs(pawWallet)
				.resolves(ethers.utils.parseEther("200"));
			paw.getBalance
				.withArgs(config.PawUsersDepositsHotWallet)
				.resolves(ethers.utils.parseEther("300"));
			paw.sendPaw.resolves(
				"6E3EB2D376517C188D8E621A8326E73D3C36295B84634F0C16354C4DE6ABE0F3"
			);
			// call the service twice...
			await svc.processWithdrawPAW(withdrawal);
			await expect(
				svc.processWithdrawPAW(withdrawal)
			).to.eventually.be.rejectedWith(
				"Can't withdraw PAW as the transaction was already processed"
			);
			// ... and expect only one withdrawal
			expect(paw.sendPaw).to.have.been.calledOnce;
			// ... to make sure the transaction is not stored twice but once!
			expect(depositsService.storeUserWithdrawal).to.have.been.calledOnce;
		});
	});

	describe("Safeguards against impersonating", () => {
		it("Checks that a swap can only be done from a valid claim", async () => {
			const amount = ethers.utils.parseEther("10");

			const pawWallet =
				"paw_1o3k8868n6d1679iz6fcz1wwwaq9hek4ykd58wsj5bozb8gkf38pm7njrr1o";

			const blockchainWallet1 = "0x71CB05EE1b1F506fF321Da3dac38f25c0c9ce6E1";
			const signature1 =
				"0x88d58d40262cf9eb69398311d75ff7a8401679fabdf9c3acb25e6fcb3dd219054fb5a356b2d621f0015b04a9fc7e5d1357febb13f6f42e0de7e8a8ddbb96921c1b";

			const blockchainWallet2 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
			const signature2 =
				"0xd739e62a9de5cf3178247c6f2cf908b7e8092d014be5899ab8aecd9ac9dd3a9a7ef1fd007eccde6bf4621dc05580e734b0227ed956d196ff3fae7817c71d8c3b1c";

			depositsService.getUserAvailableBalance
				.withArgs(pawWallet)
				.resolves(amount);
			depositsService.hasClaim
				.withArgs(pawWallet, blockchainWallet1)
				.resolves(true)
				.withArgs(pawWallet, blockchainWallet2)
				.resolves(false);
			blockchain.createMintReceipt
				.withArgs(blockchainWallet1, amount)
				.resolves({
					receipt: "0xCAFEBABE",
					uuid: "123",
					wpawBalance: BigNumber.from(0),
				})
				.withArgs(blockchainWallet2, amount)
				.resolves({
					receipt: "0xCAFEBABE",
					uuid: "123",
					wpawBalance: BigNumber.from(0),
				});

			// legit user should be able to swap
			const { receipt, uuid, wpawBalance } = await svc.processSwapToWPAW({
				from: pawWallet,
				amount: 10,
				blockchainWallet: blockchainWallet1,
				timestamp: Date.now(),
				signature: signature1,
			});
			expect(receipt).to.equal("0xCAFEBABE");
			expect(ethers.utils.formatEther(wpawBalance)).to.equal("0.0");

			// hacker trying to swap funds from a wallet he doesn't own should be able to do it
			await expect(
				svc.processSwapToWPAW({
					from: pawWallet,
					amount: 10,
					blockchainWallet: blockchainWallet2,
					timestamp: Date.now(),
					signature: signature2,
				})
			).to.eventually.be.rejectedWith(InvalidOwner);
		});
	});
});


/*
Used to create signed messages

//let mnemonic = 'test test test test test test test test test test test junk';
let mnemonic = "announce room limb pattern dry unit scale effort smooth jazz weasel alcohol";
let wallet = ethers.Wallet.fromMnemonic(mnemonic);
let message = `Swap -1 PAW for wPAW with PAW I deposited from my wallet "${pawWallet}"`;
let flatSig = await wallet.signMessage(message);
let address = wallet.address;
console.log(flatSig);
console.log(address);
*/
