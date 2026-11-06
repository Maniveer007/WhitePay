// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PayoutSplitter
/// @notice Marketplace money flows without touching WhitePay itself. A seller sets this contract as its WhitePay
///         payout wallet (through the normal timelocked `queuePayout`). Anyone can then call `sweep`, which
///         divides new funds by rules that are fixed at deployment and visible to everyone:
///           - platform fee and any other split recipients are paid immediately, in basis points;
///           - the seller's remainder is held for `holdSeconds` (chargeback / dispute window), then released.
///         During the hold the arbiter (the platform) or the seller can send held funds back to a payer
///         (`returnHeld`), which is how refunds work when the money sits in the hold. Neither can send held
///         funds anywhere else. The rules cannot be changed after deployment.
contract PayoutSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tranche { uint128 amount; uint64 releaseAt; }

    address public immutable seller;
    address public immutable arbiter;
    uint64 public immutable holdSeconds;
    address[] public recipients;
    uint16[] public bps;
    uint16 public immutable totalSplitBps;

    mapping(address => Tranche[]) private _tranches;
    mapping(address => uint256) public head;      // first unreleased tranche per token
    mapping(address => uint256) public heldTotal; // seller funds currently held per token

    event Swept(address indexed token, uint256 received, uint256 splitPaid, uint256 sellerHeld, uint64 releaseAt);
    event Released(address indexed token, uint256 amount);
    event ReturnedHeld(address indexed token, address indexed to, uint256 amount, address by, bytes32 reason);

    error BadConfig();
    error NotAuthorized();
    error NothingHeld();

    constructor(address seller_, address arbiter_, address[] memory recipients_, uint16[] memory bps_, uint64 holdSeconds_) {
        if (seller_ == address(0) || recipients_.length != bps_.length || recipients_.length > 10) revert BadConfig();
        uint256 total;
        for (uint256 i; i < bps_.length; ++i) {
            if (recipients_[i] == address(0) || bps_[i] == 0) revert BadConfig();
            total += bps_[i];
        }
        if (total > 10_000) revert BadConfig();
        seller = seller_;
        arbiter = arbiter_;
        holdSeconds = holdSeconds_;
        recipients = recipients_;
        bps = bps_;
        totalSplitBps = uint16(total);
    }

    function recipientCount() external view returns (uint256) { return recipients.length; }

    function trancheCount(address token) external view returns (uint256) { return _tranches[token].length - head[token]; }

    /// @notice Divide whatever arrived since the last sweep. Permissionless.
    function sweep(IERC20 token) public nonReentrant returns (uint256 received) {
        uint256 bal = token.balanceOf(address(this));
        received = bal - heldTotal[address(token)];
        if (received == 0) return 0;
        uint256 paid;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 part = (received * bps[i]) / 10_000;
            if (part == 0) continue;
            paid += part;
            token.safeTransfer(recipients[i], part);
        }
        uint256 rest = received - paid;
        uint64 at = uint64(block.timestamp) + holdSeconds;
        if (holdSeconds == 0) {
            if (rest > 0) token.safeTransfer(seller, rest);
            at = uint64(block.timestamp);
            emit Swept(address(token), received, paid, 0, at);
            if (rest > 0) emit Released(address(token), rest);
        } else {
            if (rest > 0) {
                _tranches[address(token)].push(Tranche(uint128(rest), at));
                heldTotal[address(token)] += rest;
            }
            emit Swept(address(token), received, paid, rest, at);
        }
    }

    /// @notice Pay the seller every tranche whose hold has passed. Permissionless.
    function release(IERC20 token) external nonReentrant returns (uint256 total) {
        Tranche[] storage ts = _tranches[address(token)];
        uint256 i = head[address(token)];
        while (i < ts.length && ts[i].releaseAt <= block.timestamp) {
            total += ts[i].amount;
            ts[i].amount = 0;
            ++i;
        }
        head[address(token)] = i;
        if (total > 0) {
            heldTotal[address(token)] -= total;
            token.safeTransfer(seller, total);
            emit Released(address(token), total);
        }
    }

    /// @notice Release funds still in the hold back to a payer (refund / dispute). Oldest tranche first.
    function returnHeld(IERC20 token, address to, uint256 amount, bytes32 reason) external nonReentrant {
        if (msg.sender != arbiter && msg.sender != seller) revert NotAuthorized();
        if (amount == 0 || amount > heldTotal[address(token)] || to == address(0)) revert NothingHeld();
        Tranche[] storage ts = _tranches[address(token)];
        uint256 left = amount;
        uint256 i = head[address(token)];
        while (left > 0 && i < ts.length) {
            uint256 take = ts[i].amount < left ? ts[i].amount : left;
            ts[i].amount -= uint128(take);
            left -= take;
            if (ts[i].amount == 0) ++i;
        }
        head[address(token)] = i;
        heldTotal[address(token)] -= amount;
        token.safeTransfer(to, amount);
        emit ReturnedHeld(address(token), to, amount, msg.sender, reason);
    }
}
