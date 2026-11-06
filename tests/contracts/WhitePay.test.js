const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDT = (n) => BigInt(Math.round(n * 1e6));
const R = ethers.encodeBytes32String("requested_by_customer");

describe("WhitePay", () => {
  let pay, usdt, admin, owner, signer, payout, alice, bob, keeper, domain, types;

  beforeEach(async () => {
    [admin, owner, signer, payout, alice, bob, keeper] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    await usdt.mint(alice.address, USDT(1000));
    await usdt.mint(owner.address, USDT(1000));
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    types = { Quote: [
      { name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" } ] };
  });

  async function quote(intent, amount = USDT(25), by = signer, ttl = 600) {
    const q = { merchantId: 1, intentId: ethers.id(intent), token: await usdt.getAddress(), amount,
      expiry: (await time.latest()) + ttl };
    return [q, await by.signTypedData(domain, types, q)];
  }

  it("pays an exact quote straight to the merchant wallet", async () => {
    const [q, sig] = await quote("o1");
    await usdt.connect(alice).approve(await pay.getAddress(), q.amount);
    await expect(pay.connect(alice).pay(q, sig)).to.emit(pay, "PaymentReceived");
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(25));
    expect(await usdt.balanceOf(await pay.getAddress())).to.equal(0); // non-custodial
  });

  it("rejects duplicate, expired and wrongly-signed quotes", async () => {
    const [q, sig] = await quote("o2");
    await usdt.connect(alice).approve(await pay.getAddress(), USDT(100));
    await pay.connect(alice).pay(q, sig);
    await expect(pay.connect(alice).pay(q, sig)).to.be.revertedWithCustomError(pay, "AlreadyPaid");
    const [q2, bad] = await quote("o3", USDT(5), alice);
    await expect(pay.connect(alice).pay(q2, bad)).to.be.revertedWithCustomError(pay, "BadSigner");
    const [q3, s3] = await quote("o4", USDT(5), signer, 10);
    await time.increase(60);
    await expect(pay.connect(alice).pay(q3, s3)).to.be.revertedWithCustomError(pay, "Expired");
  });

  it("tampered amount invalidates the signature", async () => {
    const [q, sig] = await quote("o5");
    await usdt.connect(alice).approve(await pay.getAddress(), USDT(100));
    await expect(pay.connect(alice).pay({ ...q, amount: USDT(1) }, sig)).to.be.revertedWithCustomError(pay, "BadSigner");
  });

  describe("refunds", () => {
    let q;
    beforeEach(async () => {
      let sig; [q, sig] = await quote("r1", USDT(40));
      await usdt.connect(alice).approve(await pay.getAddress(), USDT(40));
      await pay.connect(alice).pay(q, sig);
      await usdt.connect(owner).approve(await pay.getAddress(), USDT(1000));
    });

    it("is capped at the amount paid", async () => {
      await pay.connect(owner).refund(q.intentId, USDT(15), ethers.ZeroAddress, "0x", R);
      expect(await usdt.balanceOf(alice.address)).to.equal(USDT(975));
      await expect(pay.connect(owner).refund(q.intentId, USDT(26), ethers.ZeroAddress, "0x", R))
        .to.be.revertedWithCustomError(pay, "RefundExceedsPayment");
      await pay.connect(owner).refund(q.intentId, USDT(25), ethers.ZeroAddress, "0x", R);
    });

    it("only owner or refunder may refund; the API signer cannot", async () => {
      await expect(pay.connect(signer).refund(q.intentId, 1, ethers.ZeroAddress, "0x", R))
        .to.be.revertedWithCustomError(pay, "NotAuthorized");
      await pay.connect(owner).setRefunder(1, keeper.address, USDT(10), USDT(10));
      await usdt.mint(keeper.address, USDT(10));
      await usdt.connect(keeper).approve(await pay.getAddress(), USDT(10));
      await pay.connect(keeper).refund(q.intentId, USDT(10), ethers.ZeroAddress, "0x", R);
    });

    it("routes to a payer-signed alternate address", async () => {
      const rt = { RefundRoute: [{ name: "intentId", type: "bytes32" }, { name: "to", type: "address" }] };
      const psig = await alice.signTypedData(domain, rt, { intentId: q.intentId, to: bob.address });
      await expect(pay.connect(owner).refund(q.intentId, USDT(5), bob.address, "0x", R)).to.be.revertedWithCustomError(pay, "BadRefundRoute");
      await pay.connect(owner).refund(q.intentId, USDT(5), bob.address, psig, R);
      expect(await usdt.balanceOf(bob.address)).to.equal(USDT(5));
    });
  });

  describe("payout timelock (stolen API key cannot redirect funds)", () => {
    it("signer key cannot change payout; owner change is delayed", async () => {
      await expect(pay.connect(signer).queuePayout(1, signer.address)).to.be.revertedWithCustomError(pay, "NotMerchantOwner");
      await pay.connect(owner).queuePayout(1, bob.address);
      await expect(pay.connect(owner).applyPayout(1)).to.be.revertedWithCustomError(pay, "TooEarly");
      await time.increase(3601);
      await pay.connect(owner).applyPayout(1);
      const [q, sig] = await quote("t1");
      await usdt.connect(alice).approve(await pay.getAddress(), q.amount);
      await pay.connect(alice).pay(q, sig);
      expect(await usdt.balanceOf(bob.address)).to.equal(USDT(25));
    });
  });

  describe("subscriptions", () => {
    it("keeper charges on schedule within payer's cap; payer can cancel", async () => {
      const day = 86400;
      await usdt.connect(alice).approve(await pay.getAddress(), USDT(1000));
      const end = (await time.latest()) + 365 * day;
      await pay.connect(alice).subscribe(1, await usdt.getAddress(), USDT(10), day * 30, end, USDT(25));
      await pay.connect(keeper).charge(1);
      await expect(pay.connect(keeper).charge(1)).to.be.revertedWithCustomError(pay, "TooEarly");
      await time.increase(day * 30);
      await pay.connect(keeper).charge(1);
      await time.increase(day * 30);
      await expect(pay.connect(keeper).charge(1)).to.be.revertedWithCustomError(pay, "CapReached");
      expect(await usdt.balanceOf(payout.address)).to.equal(USDT(20));
      await expect(pay.connect(owner).cancel(1)).to.be.revertedWithCustomError(pay, "NotAuthorized");
      await pay.connect(alice).cancel(1);
      await expect(pay.connect(keeper).charge(1)).to.be.revertedWithCustomError(pay, "Inactive");
    });
  });
});

describe("WhitePay safety rails", () => {
  let pay, usdt, admin, owner, signer, payout, alice, newOwner, domain, types;
  const USDT = (n) => BigInt(Math.round(n * 1e6));
  beforeEach(async () => {
    [admin, owner, signer, payout, alice, newOwner] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    await usdt.mint(alice.address, USDT(1000));
    await usdt.mint(owner.address, USDT(1000));
    await usdt.connect(alice).approve(await pay.getAddress(), USDT(1000));
    await usdt.connect(owner).approve(await pay.getAddress(), USDT(1000));
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    types = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  });
  const quote = async (id, amount = USDT(10)) => {
    const q = { merchantId: 1, intentId: ethers.id(id), token: await usdt.getAddress(), amount, expiry: (await time.latest()) + 600 };
    return [q, await signer.signTypedData(domain, types, q)];
  };

  it("pause blocks new payments and charges but never refunds or cancellations", async () => {
    const [q, sig] = await quote("p1");
    await pay.connect(alice).pay(q, sig);
    const end = (await time.latest()) + 86400 * 365;
    await pay.connect(alice).subscribe(1, await usdt.getAddress(), USDT(5), 86400, end, USDT(50));
    await pay.connect(admin).setPaused(true);
    const [q2, sig2] = await quote("p2");
    await expect(pay.connect(alice).pay(q2, sig2)).to.be.revertedWithCustomError(pay, "IsPaused");
    await expect(pay.charge(1)).to.be.revertedWithCustomError(pay, "IsPaused");
    await pay.connect(owner).refund(q.intentId, USDT(10), ethers.ZeroAddress, "0x", R); // still works
    await pay.connect(alice).cancel(1);                                             // still works
    await expect(pay.connect(owner).setPaused(false)).to.be.reverted;               // only admin
  });

  it("rejects unsafe subscription terms", async () => {
    const t = await usdt.getAddress(), end = (await time.latest()) + 86400;
    await expect(pay.connect(alice).subscribe(1, t, USDT(5), 0, end, USDT(50))).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(alice).subscribe(1, t, 0, 60, end, USDT(50))).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(alice).subscribe(1, t, USDT(60), 60, end, USDT(50))).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(alice).subscribe(1, t, USDT(5), 60, 1, USDT(50))).to.be.revertedWithCustomError(pay, "InvalidTerms");
  });

  it("rejects amounts that overflow storage", async () => {
    const [q, sig] = await quote("big", 2n ** 129n);
    await expect(pay.connect(alice).pay(q, sig)).to.be.reverted;
  });

  it("merchant ownership moves in two steps (e.g. to a Safe)", async () => {
    await expect(pay.connect(newOwner).acceptOwnership(1)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await pay.connect(owner).offerOwnership(1, newOwner.address);
    await pay.connect(newOwner).acceptOwnership(1);
    expect((await pay.merchants(1)).owner).to.equal(newOwner.address);
    await expect(pay.connect(owner).queuePayout(1, owner.address)).to.be.revertedWithCustomError(pay, "NotMerchantOwner");
  });

  it("a revoked API signer's outstanding quotes stop working (key rotation)", async () => {
    const [q, sig] = await quote("rot");
    await pay.connect(owner).setQuoteSigner(1, signer.address, false);
    await expect(pay.connect(alice).pay(q, sig)).to.be.revertedWithCustomError(pay, "BadSigner");
  });
});

describe("WhitePay gasless checkout (EIP-3009)", () => {
  let pay, usdt, admin, owner, signer, payout, alice, relayer, mallory, domain, tokenDomain;
  const USDT = (n) => BigInt(Math.round(n * 1e6));
  const QT = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
    { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  const RWA = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

  beforeEach(async () => {
    [admin, owner, signer, payout, alice, relayer, mallory] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    await usdt.mint(alice.address, USDT(100));
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    tokenDomain = { name: "Tether USD", version: "1", chainId, verifyingContract: await usdt.getAddress() };
  });

  async function quote(id, amount = USDT(25)) {
    const q = { merchantId: 1, intentId: ethers.id(id), token: await usdt.getAddress(), amount, expiry: (await time.latest()) + 600 };
    return { q, sig: await signer.signTypedData(domain, QT, q) };
  }
  async function authorize(q, from = alice) {
    const nonce = ethers.TypedDataEncoder.hash(domain, QT, q); // bound to this exact quote
    const msg = { from: from.address, to: await pay.getAddress(), value: q.amount, validAfter: 0, validBefore: q.expiry, nonce };
    const { v, r, s } = ethers.Signature.from(await from.signTypedData(tokenDomain, RWA, msg));
    return { payer: from.address, validAfter: 0, validBefore: q.expiry, v, r, s, msg };
  }

  it("relayer submits; payer pays no gas; funds land at the merchant", async () => {
    const { q, sig } = await quote("g1");
    const a = await authorize(q);
    const ethBefore = await ethers.provider.getBalance(alice.address);
    await expect(pay.connect(relayer).payWithAuthorization(q, sig, a))
      .to.emit(pay, "PaymentReceived").withArgs(q.intentId, 1, alice.address, q.token, q.amount);
    expect(await usdt.balanceOf(payout.address)).to.equal(USDT(25));
    expect(await usdt.balanceOf(await pay.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(ethBefore); // zero gas for the payer
    expect((await pay.payments(q.intentId)).payer).to.equal(alice.address);      // refunds go back to the payer
  });

  it("an authorization for one quote can't pay a different quote of the same amount", async () => {
    const A = await quote("victim"), B = await quote("attacker-chosen");
    const a = await authorize(A.q);
    await expect(pay.connect(mallory).payWithAuthorization(B.q, B.sig, a)).to.be.revertedWith("invalid signature");
  });

  it("can't be front-run straight at the token, replayed, or tampered with", async () => {
    const { q, sig } = await quote("g3");
    const a = await authorize(q);
    await expect(usdt.connect(mallory).receiveWithAuthorization(a.payer, await pay.getAddress(), q.amount, 0, q.expiry, a.msg.nonce, a.v, a.r, a.s))
      .to.be.revertedWith("caller must be the payee");
    await expect(pay.connect(relayer).payWithAuthorization({ ...q, amount: USDT(1) }, sig, a)).to.be.revertedWithCustomError(pay, "BadSigner");
    await pay.connect(relayer).payWithAuthorization(q, sig, a);
    await expect(pay.connect(relayer).payWithAuthorization(q, sig, a)).to.be.revertedWithCustomError(pay, "AlreadyPaid");
  });

  it("someone else can't sign on the payer's behalf, and pause applies", async () => {
    const { q, sig } = await quote("g4");
    const forged = await authorize(q, mallory);
    await expect(pay.connect(relayer).payWithAuthorization(q, sig, { ...forged, payer: alice.address })).to.be.revertedWith("invalid signature");
    await pay.connect(admin).setPaused(true);
    await expect(pay.connect(relayer).payWithAuthorization(q, sig, await authorize(q))).to.be.revertedWithCustomError(pay, "IsPaused");
  });
});

describe("WhitePay refund controls", () => {
  let pay, usdt, admin, owner, signer, payout, alice, bob, op, domain, types;
  const USDT = (n) => BigInt(Math.round(n * 1e6));
  const DUP = ethers.encodeBytes32String("duplicate");
  beforeEach(async () => {
    [admin, owner, signer, payout, alice, bob, op] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    for (const w of [alice, bob]) { await usdt.mint(w.address, USDT(1000)); await usdt.connect(w).approve(await pay.getAddress(), USDT(1000)); }
    for (const w of [owner, op]) { await usdt.mint(w.address, USDT(1000)); await usdt.connect(w).approve(await pay.getAddress(), USDT(1000)); }
    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "WhitePay", version: "1", chainId, verifyingContract: await pay.getAddress() };
    types = { Quote: [{ name: "merchantId", type: "uint256" }, { name: "intentId", type: "bytes32" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }] };
  });
  async function paid(id, who = alice, amount = USDT(20)) {
    const q = { merchantId: 1, intentId: ethers.id(id), token: await usdt.getAddress(), amount, expiry: (await time.latest()) + 600 };
    await pay.connect(who).pay(q, await signer.signTypedData(domain, types, q));
    return q.intentId;
  }

  it("every refund needs a reason code, recorded in the event with the operator", async () => {
    const id = await paid("r1");
    await expect(pay.connect(owner).refund(id, USDT(5), ethers.ZeroAddress, "0x", ethers.ZeroHash)).to.be.revertedWithCustomError(pay, "ReasonRequired");
    await expect(pay.connect(owner).refund(id, USDT(5), ethers.ZeroAddress, "0x", DUP))
      .to.emit(pay, "Refunded").withArgs(id, alice.address, USDT(5), USDT(5), DUP, owner.address);
  });

  it("bulk refund pays every original payer in one tx, and is all-or-nothing", async () => {
    const a = await paid("b1", alice), b = await paid("b2", bob);
    const before = [await usdt.balanceOf(alice.address), await usdt.balanceOf(bob.address)];
    await pay.connect(owner).refundBatch([a, b], [USDT(20), USDT(7)], DUP);
    expect(await usdt.balanceOf(alice.address)).to.equal(before[0] + USDT(20));
    expect(await usdt.balanceOf(bob.address)).to.equal(before[1] + USDT(7));
    // one over-refund in the batch reverts all of it
    await expect(pay.connect(owner).refundBatch([b, a], [USDT(1), USDT(1)], DUP)).to.be.revertedWithCustomError(pay, "RefundExceedsPayment");
    expect((await pay.payments(b)).refunded).to.equal(USDT(7));
    await expect(pay.connect(owner).refundBatch([a], [], DUP)).to.be.revertedWithCustomError(pay, "InvalidTerms");
  });

  it("operator limits: per-refund max and daily budget; above that needs the owner", async () => {
    const ids = [await paid("o1"), await paid("o2"), await paid("o3")];
    await expect(pay.connect(op).refund(ids[0], USDT(1), ethers.ZeroAddress, "0x", DUP)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await expect(pay.connect(owner).setRefunder(1, op.address, USDT(20), USDT(10))).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await pay.connect(owner).setRefunder(1, op.address, USDT(10), USDT(25));
    await expect(pay.connect(op).refund(ids[0], USDT(11), ethers.ZeroAddress, "0x", DUP)).to.be.revertedWithCustomError(pay, "RefundLimitExceeded");
    await pay.connect(op).refund(ids[0], USDT(10), ethers.ZeroAddress, "0x", DUP);
    await pay.connect(op).refundBatch([ids[1]], [USDT(10)], DUP);
    await expect(pay.connect(op).refund(ids[2], USDT(10), ethers.ZeroAddress, "0x", DUP)).to.be.revertedWithCustomError(pay, "RefundLimitExceeded"); // 30 > 25/day
    await pay.connect(owner).refund(ids[2], USDT(20), ethers.ZeroAddress, "0x", DUP);   // owner approves the big one
    await time.increase(86400);
    await pay.connect(op).refund(ids[1], USDT(5), ethers.ZeroAddress, "0x", DUP);       // budget resets next day
    await pay.connect(owner).setRefunder(1, op.address, 0, 0);
    await expect(pay.connect(op).refund(ids[1], USDT(1), ethers.ZeroAddress, "0x", DUP)).to.be.revertedWithCustomError(pay, "NotAuthorized");
  });

  it("an operator of one merchant can't refund another merchant's payments", async () => {
    await pay.connect(bob).registerMerchant(bob.address, signer.address); // merchant #2
    await pay.connect(bob).setRefunder(2, op.address, USDT(100), USDT(100));
    const id = await paid("x1"); // merchant #1
    await expect(pay.connect(op).refund(id, USDT(1), ethers.ZeroAddress, "0x", DUP)).to.be.revertedWithCustomError(pay, "NotAuthorized");
  });
});

describe("WhitePay subscription lifecycle (plans)", () => {
  let pay, usdt, admin, owner, signer, payout, alice, keeper, mallory, T;
  const USDT = (n) => BigInt(Math.round(n * 1e6));
  const DAY = 86400, MONTH = 30 * DAY;
  beforeEach(async () => {
    [admin, owner, signer, payout, alice, keeper, mallory] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    T = await usdt.getAddress();
    await usdt.mint(alice.address, USDT(1000));
    await usdt.connect(alice).approve(await pay.getAddress(), USDT(1000));
  });
  const plan = async (amount, { trial = 0, intro = 0, introCycles = 0, period = MONTH } = {}) => {
    await pay.connect(owner).createPlan(1, T, USDT(amount), period, trial, USDT(intro), introCycles);
    return Number(await pay.planCount());
  };
  const sub = async (planId, cap = 500) => {
    await pay.connect(alice).subscribeToPlan(planId, USDT(cap), (await time.latest()) + 365 * DAY);
    return Number(await pay.subCount());
  };
  const bal = () => usdt.balanceOf(payout.address);

  it("only the merchant owner creates plans, with sane terms", async () => {
    await expect(pay.connect(mallory).createPlan(1, T, USDT(10), MONTH, 0, 0, 0)).to.be.revertedWithCustomError(pay, "NotMerchantOwner");
    await expect(pay.connect(owner).createPlan(1, T, USDT(10), 0, 0, 0, 0)).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(owner).createPlan(1, T, USDT(10), MONTH, 0, USDT(20), 1)).to.be.revertedWithCustomError(pay, "InvalidTerms"); // intro > price
    await expect(pay.connect(owner).createPlan(1, T, USDT(10), MONTH, 0, USDT(5), 0)).to.be.revertedWithCustomError(pay, "InvalidTerms");  // intro without cycles
  });

  it("free trial: nothing is charged until the trial ends", async () => {
    const id = await sub(await plan(20, { trial: 14 * DAY }));
    await expect(pay.connect(keeper).charge(id)).to.be.revertedWithCustomError(pay, "TooEarly");
    await time.increase(14 * DAY);
    await pay.connect(keeper).charge(id);
    expect(await bal()).to.equal(USDT(20));
  });

  it("intro pricing for the first N charges, then the regular price", async () => {
    const id = await sub(await plan(20, { intro: 5, introCycles: 2 }));
    await pay.connect(keeper).charge(id);
    await time.increase(MONTH); await pay.connect(keeper).charge(id);
    await time.increase(MONTH); await pay.connect(keeper).charge(id);
    expect(await bal()).to.equal(USDT(5 + 5 + 20));
  });

  it("pause stops charges; a payer's pause can't be lifted by the merchant", async () => {
    const id = await sub(await plan(20));
    await pay.connect(keeper).charge(id);
    await expect(pay.connect(mallory).pauseSubscription(id)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await pay.connect(alice).pauseSubscription(id);
    await time.increase(3 * MONTH);
    await expect(pay.connect(keeper).charge(id)).to.be.revertedWithCustomError(pay, "SubIsPaused");
    await expect(pay.connect(owner).resumeSubscription(id)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await pay.connect(alice).resumeSubscription(id);
    await pay.connect(keeper).charge(id);                                   // one charge on resume…
    await expect(pay.connect(keeper).charge(id)).to.be.revertedWithCustomError(pay, "TooEarly"); // …not 3 months of catch-up
    expect(await bal()).to.equal(USDT(40));
  });

  it("merchant can pause (e.g. support hold) and lift its own pause", async () => {
    const id = await sub(await plan(20));
    await pay.connect(owner).pauseSubscription(id);
    await pay.connect(owner).resumeSubscription(id);
    await pay.connect(keeper).charge(id);
    expect(await bal()).to.equal(USDT(20));
  });

  it("upgrade charges the prorated difference now; downgrade waits for the next period", async () => {
    const basic = await plan(10), pro = await plan(30), mini = await plan(5);
    const id = await sub(basic);
    await pay.connect(keeper).charge(id);                 // 10 paid for this month
    await time.increase(MONTH / 2);
    await pay.connect(alice).changePlan(id, pro);         // ≈ half a month of +20 → ≈10
    const afterUpgrade = await bal();
    expect(afterUpgrade - USDT(10)).to.be.closeTo(USDT(10), USDT(0.01));
    await time.increase(MONTH / 2);
    await pay.connect(keeper).charge(id);
    expect((await bal()) - afterUpgrade).to.equal(USDT(30));
    await pay.connect(alice).changePlan(id, mini);         // downgrade: no refund, no charge now
    expect((await pay.subState(id)).pendingPlanId).to.equal(mini);
    await time.increase(MONTH);
    const before = await bal();
    await pay.connect(keeper).charge(id);
    expect((await bal()) - before).to.equal(USDT(5));
    await expect(pay.connect(mallory).changePlan(id, pro)).to.be.revertedWithCustomError(pay, "NotAuthorized");
  });

  it("plan changes must stay within the same merchant, token and period, and within the cap", async () => {
    const a = await plan(10), weekly = await plan(30, { period: 7 * DAY }), big = await plan(400);
    const id = await sub(a, 100);
    await pay.connect(keeper).charge(id);
    await expect(pay.connect(alice).changePlan(id, weekly)).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(alice).changePlan(id, big)).to.be.revertedWithCustomError(pay, "CapReached");
  });

  it("retired plans take no new subscribers but keep existing ones", async () => {
    const p = await plan(10);
    const id = await sub(p);
    await pay.connect(owner).setPlanActive(p, false);
    await expect(pay.connect(alice).subscribeToPlan(p, USDT(100), (await time.latest()) + 365 * DAY)).to.be.revertedWithCustomError(pay, "Inactive");
    await pay.connect(keeper).charge(id);
    expect(await bal()).to.equal(USDT(10));
  });
});

describe("WhitePay subscription refunds", () => {
  let pay, usdt, admin, owner, signer, payout, alice, bob, op;
  const USDT = (n) => BigInt(Math.round(n * 1e6));
  const R = ethers.encodeBytes32String("other");
  beforeEach(async () => {
    [admin, owner, signer, payout, alice, bob, op] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    pay = await (await ethers.getContractFactory("WhitePay")).deploy(admin.address, await usdt.getAddress(), 3600);
    await pay.connect(owner).registerMerchant(payout.address, signer.address);
    for (const w of [alice, owner, op]) { await usdt.mint(w.address, USDT(1000)); await usdt.connect(w).approve(await pay.getAddress(), USDT(1000)); }
    const end = (await time.latest()) + 365 * 86400;
    await pay.connect(alice).subscribe(1, await usdt.getAddress(), USDT(30), 30 * 86400, end, USDT(300));
    await time.increase(1); await pay.charge(1);               // one charge of 30 USDT
  });

  it("refunds part of what was charged, to the payer, with a reason, and tracks the total", async () => {
    const before = await usdt.balanceOf(alice.address);
    await expect(pay.connect(owner).refundSubscription(1, USDT(12), R)).to.emit(pay, "SubscriptionRefunded").withArgs(1, alice.address, USDT(12), USDT(12), R, owner.address);
    expect(await usdt.balanceOf(alice.address) - before).to.equal(USDT(12));
    await pay.connect(owner).refundSubscription(1, USDT(18), R);
    expect(await pay.subRefunded(1)).to.equal(USDT(30));
  });

  it("can never refund more than was charged", async () => {
    await pay.connect(owner).refundSubscription(1, USDT(25), R);
    await expect(pay.connect(owner).refundSubscription(1, USDT(6), R)).to.be.revertedWithCustomError(pay, "RefundExceedsPayment");
  });

  it("needs a reason, a real amount and a known subscription", async () => {
    await expect(pay.connect(owner).refundSubscription(1, USDT(1), ethers.ZeroHash)).to.be.revertedWithCustomError(pay, "ReasonRequired");
    await expect(pay.connect(owner).refundSubscription(1, 0, R)).to.be.revertedWithCustomError(pay, "InvalidTerms");
    await expect(pay.connect(owner).refundSubscription(99, USDT(1), R)).to.be.revertedWithCustomError(pay, "Inactive");
  });

  it("only the owner or a limited operator may refund; limits are enforced", async () => {
    await expect(pay.connect(op).refundSubscription(1, USDT(5), R)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await expect(pay.connect(alice).refundSubscription(1, USDT(5), R)).to.be.revertedWithCustomError(pay, "NotAuthorized");
    await pay.connect(owner).setRefunder(1, op.address, USDT(10), USDT(10));
    await expect(pay.connect(op).refundSubscription(1, USDT(11), R)).to.be.revertedWithCustomError(pay, "RefundLimitExceeded");
    await pay.connect(op).refundSubscription(1, USDT(10), R);
  });

  it("still works after the subscriber cancels and while the contract is paused", async () => {
    await pay.connect(alice).cancel(1);
    await pay.connect(admin).setPaused(true);
    await pay.connect(owner).refundSubscription(1, USDT(10), R);
    expect(await pay.subRefunded(1)).to.equal(USDT(10));
  });
});
