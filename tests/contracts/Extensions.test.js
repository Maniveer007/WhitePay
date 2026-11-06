const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDT = (n) => BigInt(Math.round(n * 1e6));
const R = ethers.encodeBytes32String("dispute");
const DAY = 86400;

describe("Marketplace money flows: PayoutSplitter", () => {
  let pay, usdt, admin, owner, signer, seller, platform, partner, alice, arbiter, split, domain, types;

  async function quote(intent, amount) {
    const q = { merchantId: 1, intentId: ethers.id(intent), token: await usdt.getAddress(), amount, expiry: (await time.latest()) + 600 };
    return [q, await signer.signTypedData(domain, types, q)];
  }
  async function buy(intent, amount) {
    const [q, sig] = await quote(intent, amount);
    await usdt.connect(alice).approve(await pay.getAddress(), amount);
    await pay.connect(alice).pay(q, sig);
  }

  beforeEach(async () => {
    [admin, owner, signer, seller, platform, partner, alice, arbiter] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 0);
    // 10% platform fee + 2.5% partner, rest to the seller after a 7-day hold.
    split = await (await ethers.getContractFactory("PayoutSplitter")).deploy(
      seller.address, arbiter.address, [platform.address, partner.address], [1000, 250], 7 * DAY);
    await pay.connect(owner).registerMerchant(await split.getAddress(), signer.address);
    await usdt.mint(alice.address, USDT(1000));
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    types = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  });

  it("pays fee recipients immediately and holds the seller share", async () => {
    await buy("m1", USDT(100));
    await split.sweep(await usdt.getAddress());
    expect(await usdt.balanceOf(platform.address)).to.equal(USDT(10));
    expect(await usdt.balanceOf(partner.address)).to.equal(USDT(2.5));
    expect(await usdt.balanceOf(seller.address)).to.equal(0);
    expect(await split.heldTotal(await usdt.getAddress())).to.equal(USDT(87.5));
  });

  it("releases the seller share only after the hold", async () => {
    await buy("m2", USDT(100));
    const t = await usdt.getAddress();
    await split.sweep(t);
    await split.release(t);
    expect(await usdt.balanceOf(seller.address)).to.equal(0);
    await time.increase(7 * DAY + 1);
    await split.release(t);
    expect(await usdt.balanceOf(seller.address)).to.equal(USDT(87.5));
    expect(await usdt.balanceOf(await split.getAddress())).to.equal(0);
  });

  it("each sweep is its own tranche with its own release time", async () => {
    const t = await usdt.getAddress();
    await buy("a", USDT(40)); await split.sweep(t);
    await time.increase(4 * DAY);
    await buy("b", USDT(40)); await split.sweep(t);
    await time.increase(4 * DAY); // first tranche is 8 days old, second 4
    await split.release(t);
    expect(await usdt.balanceOf(seller.address)).to.equal(USDT(35));
    await time.increase(4 * DAY);
    await split.release(t);
    expect(await usdt.balanceOf(seller.address)).to.equal(USDT(70));
  });

  it("lets the arbiter or seller return held funds, nobody else, and only up to what is held", async () => {
    const t = await usdt.getAddress();
    await buy("d", USDT(100)); await split.sweep(t);
    await expect(split.connect(alice).returnHeld(t, alice.address, USDT(10), R)).to.be.revertedWithCustomError(split, "NotAuthorized");
    await expect(split.connect(arbiter).returnHeld(t, alice.address, USDT(90), R)).to.be.revertedWithCustomError(split, "NothingHeld");
    const before = await usdt.balanceOf(alice.address);
    await split.connect(arbiter).returnHeld(t, alice.address, USDT(30), R);
    expect(await usdt.balanceOf(alice.address) - before).to.equal(USDT(30));
    await time.increase(8 * DAY);
    await split.release(t);
    expect(await usdt.balanceOf(seller.address)).to.equal(USDT(57.5));
  });

  it("sweep is idempotent and zero-hold pays the seller at once", async () => {
    const t = await usdt.getAddress();
    const instant = await (await ethers.getContractFactory("PayoutSplitter")).deploy(seller.address, arbiter.address, [platform.address], [500], 0);
    await usdt.mint(await instant.getAddress(), USDT(200));
    await instant.sweep(t); await instant.sweep(t);
    expect(await usdt.balanceOf(platform.address)).to.equal(USDT(10));
    expect(await usdt.balanceOf(seller.address)).to.equal(USDT(190));
  });

  it("rejects bad configurations", async () => {
    const F = await ethers.getContractFactory("PayoutSplitter");
    await expect(F.deploy(seller.address, arbiter.address, [platform.address], [10001], 0)).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(F.deploy(seller.address, arbiter.address, [platform.address], [], 0)).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(F.deploy(ethers.ZeroAddress, arbiter.address, [], [], 0)).to.be.revertedWithCustomError(F, "BadConfig");
  });
});

describe("Seat and metered billing: WhitePayMetered", () => {
  let pay, usdt, meter, admin, owner, signer, payout, alice, bob, mid;
  const terms = (o = {}) => ({ seatPrice: USDT(10), seats: 5, unitPrice: USDT(0.01), usageBudget: USDT(20), period: 30 * DAY, cap: USDT(500), end: 0, ...o });

  beforeEach(async () => {
    [admin, owner, signer, payout, alice, bob] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 0);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    meter = await (await ethers.getContractFactory("WhitePayMetered")).deploy(await pay.getAddress());
    await usdt.mint(alice.address, USDT(2000));
    await usdt.connect(alice).approve(await meter.getAddress(), USDT(2000));
    mid = 1;
  });
  const open = async (o) => {
    const t = terms({ end: (await time.latest()) + 365 * DAY, ...o });
    await meter.connect(alice).open(mid, await usdt.getAddress(), t);
    return Number(await meter.meterCount());
  };

  it("bills seats once per period, directly to the merchant", async () => {
    const id = await open();
    await meter.chargeSeats(id);
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(50));
    await expect(meter.chargeSeats(id)).to.be.revertedWithCustomError(meter, "TooEarly");
    await time.increase(30 * DAY);
    await meter.chargeSeats(id);
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(100));
    expect(await usdt.balanceOf(await meter.getAddress())).to.equal(0);
  });

  it("late seat billing never charges back-to-back", async () => {
    const id = await open();
    await meter.chargeSeats(id);
    await time.increase(100 * DAY);
    await meter.chargeSeats(id);
    await expect(meter.chargeSeats(id)).to.be.revertedWithCustomError(meter, "TooEarly");
  });

  it("adding seats bills the rest of the period pro rata; removing waits for the next period", async () => {
    const id = await open();
    await meter.chargeSeats(id);
    await time.increase(15 * DAY);
    const before = await usdt.balanceOf(payout.address);
    await meter.connect(alice).setSeats(id, 7); // +2 seats × $10 × ~half a period
    const extra = (await usdt.balanceOf(payout.address)) - before;
    expect(extra).to.be.closeTo(USDT(10), USDT(0.1));
    await meter.connect(alice).setSeats(id, 3);
    expect(await usdt.balanceOf(payout.address)).to.equal(before + extra); // nothing refunded or charged now
    await time.increase(15 * DAY);
    await meter.chargeSeats(id);
    expect(await usdt.balanceOf(payout.address)).to.equal(before + extra + USDT(30));
  });

  it("only the payer changes seats", async () => {
    const id = await open();
    await expect(meter.connect(bob).setSeats(id, 9)).to.be.revertedWithCustomError(meter, "NotPayer");
  });

  it("charges usage at the payer's unit price within the period budget", async () => {
    const id = await open();
    const rid = (s) => ethers.id(s);
    await meter.connect(signer).chargeUsage(id, 1000, rid("r1")); // 1000 × 0.01 = $10
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(10));
    await meter.connect(owner).chargeUsage(id, 1000, rid("r2")); // owner may report too
    await expect(meter.connect(signer).chargeUsage(id, 1, rid("r3"))).to.be.revertedWithCustomError(meter, "BudgetExceeded");
    await time.increase(30 * DAY); // new window
    await meter.connect(signer).chargeUsage(id, 500, rid("r4"));
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(25));
  });

  it("a usage report id is applied exactly once", async () => {
    const id = await open();
    await meter.connect(signer).chargeUsage(id, 10, ethers.id("same"));
    await expect(meter.connect(signer).chargeUsage(id, 10, ethers.id("same"))).to.be.revertedWithCustomError(meter, "AlreadyReported");
  });

  it("only the merchant can report usage", async () => {
    const id = await open();
    await expect(meter.connect(bob).chargeUsage(id, 10, ethers.id("x"))).to.be.revertedWithCustomError(meter, "NotMerchant");
    await expect(meter.connect(alice).chargeUsage(id, 10, ethers.id("x"))).to.be.revertedWithCustomError(meter, "NotMerchant");
  });

  it("the lifetime cap bounds seats and usage together", async () => {
    const id = await open({ cap: USDT(60), usageBudget: USDT(100) });
    await meter.chargeSeats(id);                                   // $50
    await expect(meter.connect(signer).chargeUsage(id, 1001, ethers.id("c"))).to.be.revertedWithCustomError(meter, "CapReached");
    await meter.connect(signer).chargeUsage(id, 1000, ethers.id("c2")); // exactly $10 more
    await time.increase(30 * DAY);
    await expect(meter.chargeSeats(id)).to.be.revertedWithCustomError(meter, "CapReached");
  });

  it("the payer can cancel at any time, even when WhitePay is paused", async () => {
    const id = await open();
    await pay.setPaused(true);
    await meter.connect(alice).cancel(id);
    await pay.setPaused(false);
    await expect(meter.chargeSeats(id)).to.be.revertedWithCustomError(meter, "Inactive");
    await expect(meter.connect(signer).chargeUsage(id, 1, ethers.id("z"))).to.be.revertedWithCustomError(meter, "Inactive");
  });

  it("pausing WhitePay stops new charges", async () => {
    const id = await open();
    await pay.setPaused(true);
    await expect(meter.chargeSeats(id)).to.be.revertedWithCustomError(meter, "IsPaused");
  });

  it("rejects incoherent terms", async () => {
    const tok = await usdt.getAddress(), end = (await time.latest()) + DAY;
    await expect(meter.connect(alice).open(99, tok, terms({ end }))).to.be.revertedWithCustomError(meter, "InvalidTerms");
    await expect(meter.connect(alice).open(mid, tok, terms({ end, seats: 0 }))).to.be.revertedWithCustomError(meter, "InvalidTerms");
    await expect(meter.connect(alice).open(mid, tok, terms({ end, cap: USDT(10) }))).to.be.revertedWithCustomError(meter, "InvalidTerms");
    await expect(meter.connect(alice).open(mid, tok, terms({ end, usageBudget: 0 }))).to.be.revertedWithCustomError(meter, "InvalidTerms");
    await expect(meter.connect(alice).open(mid, ethers.Wallet.createRandom().address, terms({ end }))).to.be.revertedWithCustomError(meter, "TokenNotAllowed");
  });

  it("usage-only and seat-only meters both work", async () => {
    const usageOnly = await open({ seatPrice: 0, seats: 0 });
    await expect(meter.chargeSeats(usageOnly)).to.be.revertedWithCustomError(meter, "Inactive");
    const seatOnly = await open({ unitPrice: 0, usageBudget: 0 });
    await expect(meter.connect(signer).chargeUsage(seatOnly, 1, ethers.id("q"))).to.be.revertedWithCustomError(meter, "Inactive");
  });
});

describe("AI agent spending policies: WhitePayAgent", () => {
  let pay, usdt, agentMod, admin, merchantOwner, signer, payout, human, agent, stranger, domain, types;

  async function quote(intent, amount, merchantId = 1) {
    const q = { merchantId, intentId: ethers.id(intent), token: await usdt.getAddress(), amount, expiry: (await time.latest()) + 600 };
    return [q, await signer.signTypedData(domain, types, q)];
  }

  beforeEach(async () => {
    [admin, merchantOwner, signer, payout, human, agent, stranger] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 0);
    await pay.connect(merchantOwner).registerMerchant(payout.address, signer.address);
    agentMod = await (await ethers.getContractFactory("WhitePayAgent")).deploy(await pay.getAddress());
    await pay.setAgentModule(await agentMod.getAddress());
    await usdt.mint(human.address, USDT(500));
    await usdt.connect(human).approve(await pay.getAddress(), USDT(500));
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    types = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  });
  const grant = async (o = {}) => agentMod.connect(human).setPolicy(agent.address, o.perPayment ?? USDT(10), o.perDay ?? USDT(25),
    o.expiry ?? (await time.latest()) + 7 * DAY, o.restrict ?? false);

  it("an agent pays from the owner's wallet inside the policy and the payment is the owner's", async () => {
    await grant();
    const [q, sig] = await quote("x1", USDT(8));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.emit(agentMod, "AgentPaid");
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(8));
    expect(await usdt.balanceOf(human.address)).to.equal(USDT(492));
    expect((await pay.payments(q.intentId)).payer).to.equal(human.address);
  });

  it("refunds on an agent payment go back to the owner, not the agent", async () => {
    await grant();
    const [q, sig] = await quote("x2", USDT(8));
    await agentMod.connect(agent).agentPay(human.address, q, sig);
    await usdt.mint(merchantOwner.address, USDT(8));
    await usdt.connect(merchantOwner).approve(await pay.getAddress(), USDT(8));
    await pay.connect(merchantOwner).refund(q.intentId, USDT(8), ethers.ZeroAddress, "0x", R);
    expect(await usdt.balanceOf(human.address)).to.equal(USDT(500));
    expect(await usdt.balanceOf(agent.address)).to.equal(0);
  });

  it("enforces the per-payment and daily limits", async () => {
    await grant();
    let [q, sig] = await quote("big", USDT(11));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "OverPaymentLimit");
    for (const n of ["a", "b"]) { [q, sig] = await quote(n, USDT(10)); await agentMod.connect(agent).agentPay(human.address, q, sig); }
    [q, sig] = await quote("c", USDT(6));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "OverDailyLimit");
    await time.increase(DAY);
    [q, sig] = await quote("d", USDT(6));
    await agentMod.connect(agent).agentPay(human.address, q, sig); // new day, budget is back
  });

  it("re-granting a policy does not reset today's usage", async () => {
    await grant();
    let [q, sig] = await quote("r1", USDT(10)); await agentMod.connect(agent).agentPay(human.address, q, sig);
    [q, sig] = await quote("r2", USDT(10)); await agentMod.connect(agent).agentPay(human.address, q, sig);
    await grant();
    [q, sig] = await quote("r3", USDT(6));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "OverDailyLimit");
  });

  it("enforces expiry, revocation and the merchant allowlist", async () => {
    await grant({ restrict: true });
    let [q, sig] = await quote("m1", USDT(5));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "MerchantNotAllowed");
    await agentMod.connect(human).allowMerchant(agent.address, 1, true);
    await agentMod.connect(agent).agentPay(human.address, q, sig);
    [q, sig] = await quote("m2", USDT(5));
    await agentMod.connect(human).revoke(agent.address);
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "NoPolicy");
    await grant({ expiry: (await time.latest()) + 100 });
    await time.increase(200);
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "PolicyExpired");
  });

  it("a stranger cannot spend someone's allowance", async () => {
    await grant();
    const [q, sig] = await quote("s1", USDT(5));
    await expect(agentMod.connect(stranger).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(agentMod, "NoPolicy");
  });

  it("payFor is closed to everyone but the registered module", async () => {
    const [q, sig] = await quote("p1", USDT(5));
    await expect(pay.connect(stranger).payFor(q, sig, human.address)).to.be.revertedWithCustomError(pay, "NotAgentModule");
    await expect(pay.connect(agent).payFor(q, sig, human.address)).to.be.revertedWithCustomError(pay, "NotAgentModule");
  });

  it("only the WhitePay admin can register the module, and it can be switched off", async () => {
    await expect(pay.connect(stranger).setAgentModule(stranger.address)).to.be.reverted;
    await grant();
    await pay.setAgentModule(ethers.ZeroAddress);
    const [q, sig] = await quote("off", USDT(5));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(pay, "NotAgentModule");
  });

  it("a payment can only be made once, by agent or by wallet", async () => {
    await grant();
    const [q, sig] = await quote("dup", USDT(5));
    await agentMod.connect(agent).agentPay(human.address, q, sig);
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(pay, "AlreadyPaid");
    await expect(pay.connect(human).pay(q, sig)).to.be.revertedWithCustomError(pay, "AlreadyPaid");
  });

  it("a tampered quote is rejected", async () => {
    await grant();
    const [q, sig] = await quote("t", USDT(5));
    await expect(agentMod.connect(agent).agentPay(human.address, { ...q, amount: USDT(1) }, sig)).to.be.revertedWithCustomError(pay, "BadSigner");
  });

  it("a paused WhitePay blocks agent payments too", async () => {
    await grant();
    await pay.setPaused(true);
    const [q, sig] = await quote("pz", USDT(5));
    await expect(agentMod.connect(agent).agentPay(human.address, q, sig)).to.be.revertedWithCustomError(pay, "IsPaused");
  });

  it("rejects bad policy terms", async () => {
    const t = (await time.latest()) + DAY;
    await expect(agentMod.connect(human).setPolicy(agent.address, USDT(30), USDT(10), t, false)).to.be.revertedWithCustomError(agentMod, "InvalidTerms");
    await expect(agentMod.connect(human).setPolicy(ethers.ZeroAddress, USDT(1), USDT(10), t, false)).to.be.revertedWithCustomError(agentMod, "InvalidTerms");
    await expect(agentMod.connect(human).setPolicy(agent.address, USDT(1), USDT(10), 1, false)).to.be.revertedWithCustomError(agentMod, "InvalidTerms");
  });
});
