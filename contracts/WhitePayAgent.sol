// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWhitePayAgentCore {
    struct Quote { uint256 merchantId; bytes32 intentId; address token; uint256 amount; uint64 expiry; }
    function payFor(Quote calldata q, bytes calldata sig, address payer) external;
}

/// @title WhitePayAgent
/// @notice Spending policies for AI agents (or any hot key). An owner wallet grants an agent address a budget:
///         a limit per payment, a limit per UTC day, an expiry and an optional merchant allowlist. The agent then
///         pays signed WhitePay quotes with its own key, and the money moves from the OWNER's wallet straight to the
///         merchant, recorded in WhitePay as the owner's payment (so refunds return to the owner). The owner keeps
///         the funds in their own wallet and can revoke the agent at any moment, no matter what the agent does.
///         WhitePay only accepts `payFor` from this module, and the module only acts inside the owner's policy.
contract WhitePayAgent is ReentrancyGuard {
    struct Policy {
        uint128 perPayment;
        uint128 perDay;
        uint128 usedToday;
        uint64 day;
        uint64 expiry;
        bool restrictMerchants;
        bool active;
    }

    IWhitePayAgentCore public immutable core;
    mapping(address => mapping(address => Policy)) public policies;                     // owner → agent
    mapping(address => mapping(address => mapping(uint256 => bool))) public merchantAllowed; // owner → agent → merchantId

    event PolicySet(address indexed owner, address indexed agent, uint256 perPayment, uint256 perDay, uint256 expiry, bool restrictMerchants);
    event MerchantAllowed(address indexed owner, address indexed agent, uint256 indexed merchantId, bool allowed);
    event PolicyRevoked(address indexed owner, address indexed agent);
    event AgentPaid(address indexed owner, address indexed agent, uint256 indexed merchantId, bytes32 intentId, uint256 amount);

    error NoPolicy();
    error PolicyExpired();
    error OverPaymentLimit();
    error OverDailyLimit();
    error MerchantNotAllowed();
    error InvalidTerms();

    constructor(address core_) { core = IWhitePayAgentCore(core_); }

    /// @notice Owner grants or replaces an agent's policy. Replacing keeps today's usage so a limit can't be reset by re-granting.
    function setPolicy(address agent, uint128 perPayment, uint128 perDay, uint64 expiry, bool restrictMerchants) external {
        if (agent == address(0) || perPayment == 0 || perPayment > perDay || expiry <= block.timestamp) revert InvalidTerms();
        Policy storage p = policies[msg.sender][agent];
        p.perPayment = perPayment;
        p.perDay = perDay;
        p.expiry = expiry;
        p.restrictMerchants = restrictMerchants;
        p.active = true;
        emit PolicySet(msg.sender, agent, perPayment, perDay, expiry, restrictMerchants);
    }

    function allowMerchant(address agent, uint256 merchantId, bool allowed) external {
        merchantAllowed[msg.sender][agent][merchantId] = allowed;
        emit MerchantAllowed(msg.sender, agent, merchantId, allowed);
    }

    function revoke(address agent) external {
        policies[msg.sender][agent].active = false;
        emit PolicyRevoked(msg.sender, agent);
    }

    /// @notice Agent pays a merchant-signed quote from `owner`'s wallet, if the owner's policy allows it.
    function agentPay(address owner, IWhitePayAgentCore.Quote calldata q, bytes calldata sig) external nonReentrant {
        Policy storage p = policies[owner][msg.sender];
        if (!p.active) revert NoPolicy();
        if (block.timestamp > p.expiry) revert PolicyExpired();
        if (q.amount > p.perPayment) revert OverPaymentLimit();
        if (p.restrictMerchants && !merchantAllowed[owner][msg.sender][q.merchantId]) revert MerchantNotAllowed();
        uint64 today = uint64(block.timestamp / 1 days);
        if (p.day != today) { p.day = today; p.usedToday = 0; }
        if (uint256(p.usedToday) + q.amount > p.perDay) revert OverDailyLimit();
        p.usedToday += uint128(q.amount);
        core.payFor(q, sig, owner);
        emit AgentPaid(owner, msg.sender, q.merchantId, q.intentId, q.amount);
    }
}
