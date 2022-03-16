type WithdrawalRequest = {
	amount: number;
	paw: string;
	blockchain: string;
	sig: string;
};

export default WithdrawalRequest;
