import PawUserDeposit from "./PawUserDeposit";
import PawUserWithdrawal from "./PawUserWithdrawal";
import SwapPawToWPAW from "./SwapPawToWPAW";
import SwapWPAWToPaw from "./SwapWPAWToPaw";

export declare type Operation =
	| PawUserDeposit
	| PawUserWithdrawal
	| SwapPawToWPAW
	| SwapWPAWToPaw;

export enum OperationsNames {
	PawDeposit = "paw-deposit",
	PawWithdrawal = "paw-withdrawal",
	SwapToWPAW = "swap-paw-to-wpaw",
	SwapToPAW = "swap-wpaw-to-paw",
}
