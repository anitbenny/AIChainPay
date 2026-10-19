// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function pay(address payable recipient, uint256 amount, string calldata memo, bytes32 requestId) external;
}

contract RejectingReceiver {
    receive() external payable { revert("reject"); }
}

contract ReentrantReceiver {
    IVault public immutable vault;
    bool public attempted;
    bool public reentrySucceeded;

    constructor(address vault_) { vault = IVault(vault_); }

    function depositToVault() external payable { vault.deposit{value: msg.value}(); }
    function withdrawFromVault(uint256 amount) external { vault.withdraw(amount); }

    receive() external payable {
        attempted = true;
        try vault.withdraw(1) { reentrySucceeded = true; } catch {}
    }
}

contract ForceEther {
    constructor() payable {}
    function force(address payable target) external { selfdestruct(target); }
}
