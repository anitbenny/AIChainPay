// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AIChainPay
/// @notice Sepolia-only educational vault. The owner grants a bounded agent permission.
contract AIChainPay is ReentrancyGuard {
    uint256 public constant MAX_MEMO_BYTES = 140;
    uint256 public constant MAX_ALLOWED_RECIPIENTS = 20;

    error ZeroAmount();
    error InvalidRecipient();
    error InvalidAgent();
    error InvalidGrant();
    error InvalidExpiry();
    error TooManyRecipients();
    error DuplicateRecipient();
    error MemoTooLong();
    error InsufficientBalance();
    error PermissionInactive();
    error PermissionExpired();
    error StalePermission();
    error RequestExpired();
    error RequestUsed();
    error InvalidRequestId();
    error PaymentTooLarge();
    error AllowanceExceeded();
    error RecipientNotAllowed();
    error TransferFailed();
    error IndexOutOfBounds();
    error DirectTransferDisabled();

    struct AgentPermission {
        bool active;
        uint256 remainingAllowance;
        uint256 maxPerPayment;
        uint64 expiresAt;
        uint256 epoch;
        bool restrictedRecipients;
    }

    struct Payment {
        uint256 id;
        address owner;
        address recipient;
        address executor;
        uint256 amount;
        string memo;
        bytes32 requestId;
        uint64 timestamp;
    }

    mapping(address => uint256) public balances;
    uint256 public totalLiabilities;
    mapping(address => mapping(address => AgentPermission)) private permissions;
    mapping(address => mapping(address => mapping(uint256 => mapping(address => bool)))) private allowedRecipients;
    mapping(address => mapping(bytes32 => bool)) public usedRequestIds;
    Payment[] private payments;
    mapping(address => uint256[]) private participantPaymentIds;

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event AgentGranted(address indexed owner, address indexed agent, uint256 indexed epoch, uint256 allowance, uint256 maxPerPayment, uint64 expiresAt, bool restrictedRecipients);
    event AgentRevoked(address indexed owner, address indexed agent, uint256 indexed epoch);
    event PaymentExecuted(address indexed owner, address indexed recipient, bytes32 indexed requestId, uint256 paymentId, address executor, uint256 amount, string memo, uint64 timestamp);

    receive() external payable { revert DirectTransferDisabled(); }
    fallback() external payable { revert DirectTransferDisabled(); }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        totalLiabilities += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();
        balances[msg.sender] -= amount;
        totalLiabilities -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function getBalance(address owner) external view returns (uint256) { return balances[owner]; }

    function grantAgent(address agent, uint256 totalAllowance, uint256 maxPerPayment, uint64 expiresAt, address[] calldata recipients) external {
        if (agent == address(0) || agent == address(this) || agent == msg.sender) revert InvalidAgent();
        if (totalAllowance == 0 || maxPerPayment == 0 || maxPerPayment > totalAllowance) revert InvalidGrant();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        if (recipients.length > MAX_ALLOWED_RECIPIENTS) revert TooManyRecipients();

        AgentPermission storage permission = permissions[msg.sender][agent];
        uint256 nextEpoch = permission.epoch + 1;
        permission.active = true;
        permission.remainingAllowance = totalAllowance;
        permission.maxPerPayment = maxPerPayment;
        permission.expiresAt = expiresAt;
        permission.epoch = nextEpoch;
        permission.restrictedRecipients = recipients.length != 0;
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i];
            if (recipient == address(0) || recipient == address(this) || recipient == msg.sender) revert InvalidRecipient();
            if (allowedRecipients[msg.sender][agent][nextEpoch][recipient]) revert DuplicateRecipient();
            allowedRecipients[msg.sender][agent][nextEpoch][recipient] = true;
        }
        emit AgentGranted(msg.sender, agent, nextEpoch, totalAllowance, maxPerPayment, expiresAt, recipients.length != 0);
    }

    function revokeAgent(address agent) external {
        AgentPermission storage permission = permissions[msg.sender][agent];
        permission.epoch += 1;
        permission.active = false;
        permission.remainingAllowance = 0;
        permission.maxPerPayment = 0;
        permission.expiresAt = 0;
        permission.restrictedRecipients = false;
        emit AgentRevoked(msg.sender, agent, permission.epoch);
    }

    function getAgentPermission(address owner, address agent) external view returns (AgentPermission memory) {
        return permissions[owner][agent];
    }

    function isAllowedRecipient(address owner, address agent, address recipient) external view returns (bool) {
        AgentPermission storage permission = permissions[owner][agent];
        return !permission.restrictedRecipients || allowedRecipients[owner][agent][permission.epoch][recipient];
    }

    function pay(address payable recipient, uint256 amount, string calldata memo, bytes32 requestId) external nonReentrant {
        _validatePayment(msg.sender, recipient, amount, memo, requestId);
        _execute(msg.sender, recipient, amount, memo, requestId, msg.sender);
    }

    function executeAgentPayment(address owner, address payable recipient, uint256 amount, string calldata memo, bytes32 requestId, uint256 permissionEpoch, uint64 requestDeadline) external nonReentrant {
        AgentPermission storage permission = permissions[owner][msg.sender];
        if (!permission.active) revert PermissionInactive();
        if (block.timestamp >= permission.expiresAt) revert PermissionExpired();
        if (permissionEpoch != permission.epoch) revert StalePermission();
        if (block.timestamp > requestDeadline) revert RequestExpired();
        _validatePayment(owner, recipient, amount, memo, requestId);
        if (amount > permission.maxPerPayment) revert PaymentTooLarge();
        if (amount > permission.remainingAllowance) revert AllowanceExceeded();
        if (permission.restrictedRecipients && !allowedRecipients[owner][msg.sender][permission.epoch][recipient]) revert RecipientNotAllowed();
        permission.remainingAllowance -= amount;
        _execute(owner, recipient, amount, memo, requestId, msg.sender);
    }

    function _validatePayment(address owner, address recipient, uint256 amount, string calldata memo, bytes32 requestId) private view {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0) || recipient == address(this) || recipient == owner) revert InvalidRecipient();
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (usedRequestIds[owner][requestId]) revert RequestUsed();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();
        if (balances[owner] < amount) revert InsufficientBalance();
    }

    function _execute(address owner, address payable recipient, uint256 amount, string calldata memo, bytes32 requestId, address executor) private {
        balances[owner] -= amount;
        totalLiabilities -= amount;
        usedRequestIds[owner][requestId] = true;
        uint256 paymentId = payments.length;
        uint64 at = uint64(block.timestamp);
        payments.push(Payment(paymentId, owner, recipient, executor, amount, memo, requestId, at));
        participantPaymentIds[owner].push(paymentId);
        participantPaymentIds[recipient].push(paymentId);
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PaymentExecuted(owner, recipient, requestId, paymentId, executor, amount, memo, at);
    }

    function getPaymentCount(address participant) external view returns (uint256) { return participantPaymentIds[participant].length; }

    function getPayment(address participant, uint256 index) external view returns (Payment memory) {
        if (index >= participantPaymentIds[participant].length) revert IndexOutOfBounds();
        return payments[participantPaymentIds[participant][index]];
    }
}
