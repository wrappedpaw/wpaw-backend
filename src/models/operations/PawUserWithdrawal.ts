import Withdrawal from "./Withdrawal";

declare type PawUserWithdrawal = Withdrawal & {
	signature: string;
	attempt: number;
};

export default PawUserWithdrawal;
