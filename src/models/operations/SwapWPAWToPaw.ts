import Withdrawal from "./Withdrawal";

declare type SwapWPAWToPaw = Withdrawal & {
	wpawBalance: string;
	hash: string;
};

export default SwapWPAWToPaw;
