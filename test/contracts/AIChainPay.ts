import { expect } from "chai";
import hre from "hardhat";
import { parseEther, randomBytes, hexlify, ZeroAddress } from "ethers";

const { ethers, networkHelpers } = await hre.network.create();
const id = () => hexlify(randomBytes(32));
const one = parseEther("1");

async function fixture() {
  const [owner, other, agent, recipient, stranger] = await ethers.getSigners();
  const vault = await ethers.deployContract("AIChainPay");
  await vault.waitForDeployment();
  const now = BigInt(await networkHelpers.time.latest());
  return { owner, other, agent, recipient, stranger, vault, now };
}

describe("AIChainPay vault", function () {
  it("tracks deposits, withdrawals, liabilities and rejects ordinary transfers", async function () {
    const { owner, other, vault } = await networkHelpers.loadFixture(fixture);
    await expect(vault.connect(owner).deposit({ value: one })).to.emit(vault, "Deposited").withArgs(owner.address, one);
    await vault.connect(other).deposit({ value: one / 2n });
    expect(await vault.totalLiabilities()).to.equal(one + one / 2n);
    expect(await vault.getBalance(owner.address)).to.equal(one);
    await expect(vault.connect(owner).withdraw(one / 4n)).to.emit(vault, "Withdrawn").withArgs(owner.address, one / 4n);
    expect(await vault.getBalance(owner.address)).to.equal(3n * one / 4n);
    expect(await vault.totalLiabilities()).to.equal(5n * one / 4n);
    await expect(owner.sendTransaction({ to: await vault.getAddress(), value: 1n })).to.be.revertedWithCustomError(vault, "DirectTransferDisabled");
    await expect(vault.connect(owner).deposit({ value: 0 })).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(owner).withdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(owner).withdraw(one)).to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });

  it("sends direct owner payment as actual ETH and indexes both participants", async function () {
    const { owner, recipient, vault } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    const before = await ethers.provider.getBalance(recipient.address);
    const request = id();
    await expect(vault.connect(owner).pay(recipient.address, one / 4n, "demo", request))
      .to.emit(vault, "PaymentExecuted").withArgs(owner.address, recipient.address, request, 0n, owner.address, one / 4n, "demo", (x: bigint) => x > 0n);
    expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(one / 4n);
    expect(await vault.totalLiabilities()).to.equal(3n * one / 4n);
    expect(await vault.getPaymentCount(owner.address)).to.equal(1n);
    expect(await vault.getPaymentCount(recipient.address)).to.equal(1n);
    const payment = await vault.getPayment(owner.address, 0);
    expect(payment.requestId).to.equal(request);
    await expect(vault.getPayment(owner.address, 1)).to.be.revertedWithCustomError(vault, "IndexOutOfBounds");
  });

  it("enforces agent authority, budget and per-payment cap while isolating owners", async function () {
    const { owner, other, agent, recipient, stranger, vault, now } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    await vault.connect(other).deposit({ value: one });
    await vault.connect(owner).grantAgent(agent.address, one / 2n, one / 4n, now + 3600n, []);
    await expect(vault.connect(stranger).executeAgentPayment(owner.address, recipient.address, 1n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "PermissionInactive");
    await expect(vault.connect(agent).executeAgentPayment(other.address, recipient.address, 1n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "PermissionInactive");
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, one / 3n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "PaymentTooLarge");
    const before = await ethers.provider.getBalance(recipient.address);
    await vault.connect(agent).executeAgentPayment(owner.address, recipient.address, one / 4n, "agent", id(), 1n, now + 600n);
    expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(one / 4n);
    expect((await vault.getAgentPermission(owner.address, agent.address)).remainingAllowance).to.equal(one / 4n);
    expect(await vault.getBalance(other.address)).to.equal(one);
    await vault.connect(agent).executeAgentPayment(owner.address, recipient.address, one / 4n, "", id(), 1n, now + 600n);
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "AllowanceExceeded");
    await vault.connect(other).grantAgent(agent.address, one / 2n, one / 4n, now + 3600n, []);
    await vault.connect(agent).executeAgentPayment(other.address, recipient.address, one / 4n, "second owner", id(), 1n, now + 600n);
    expect(await vault.getBalance(other.address)).to.equal(one * 3n / 4n);
    expect(await vault.getBalance(owner.address)).to.equal(one / 2n);
    expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(one * 3n / 4n);
  });

  it("replaces grants, increments epochs and restricts recipients", async function () {
    const { owner, agent, recipient, stranger, vault, now } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    await vault.connect(owner).grantAgent(agent.address, one, one, now + 3600n, [recipient.address]);
    expect(await vault.isAllowedRecipient(owner.address, agent.address, recipient.address)).to.equal(true);
    expect(await vault.isAllowedRecipient(owner.address, agent.address, stranger.address)).to.equal(false);
    await expect(vault.connect(agent).executeAgentPayment(owner.address, stranger.address, 1n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "RecipientNotAllowed");
    await vault.connect(owner).grantAgent(agent.address, one / 2n, one / 4n, now + 7200n, []);
    expect((await vault.getAgentPermission(owner.address, agent.address)).epoch).to.equal(2n);
    expect(await vault.isAllowedRecipient(owner.address, agent.address, stranger.address)).to.equal(true);
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1n, "", id(), 1n, now + 600n)).to.be.revertedWithCustomError(vault, "StalePermission");
    await vault.connect(owner).revokeAgent(agent.address);
    expect((await vault.getAgentPermission(owner.address, agent.address)).epoch).to.equal(3n);
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1n, "", id(), 3n, now + 600n)).to.be.revertedWithCustomError(vault, "PermissionInactive");
    await vault.connect(owner).grantAgent(agent.address, one / 2n, one / 4n, now + 7200n, []);
    expect((await vault.getAgentPermission(owner.address, agent.address)).epoch).to.equal(4n);
    await vault.connect(owner).withdraw(one);
    expect(await vault.getBalance(owner.address)).to.equal(0n);
  });

  it("rejects invalid grants and invalid payment arguments", async function () {
    const { owner, agent, recipient, vault, now } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    await expect(vault.connect(owner).grantAgent(ZeroAddress, one, one, now + 1n, [])).to.be.revertedWithCustomError(vault, "InvalidAgent");
    await expect(vault.connect(owner).grantAgent(agent.address, one, one + 1n, now + 1n, [])).to.be.revertedWithCustomError(vault, "InvalidGrant");
    await expect(vault.connect(owner).grantAgent(agent.address, one, one, now, [])).to.be.revertedWithCustomError(vault, "InvalidExpiry");
    await expect(vault.connect(owner).grantAgent(agent.address, one, one, now + 3600n, [recipient.address, recipient.address])).to.be.revertedWithCustomError(vault, "DuplicateRecipient");
    await expect(vault.connect(owner).grantAgent(agent.address, one, one, now + 3600n, Array(21).fill(recipient.address))).to.be.revertedWithCustomError(vault, "TooManyRecipients");
    await expect(vault.connect(owner).pay(recipient.address, 0, "", id())).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(owner).pay(ZeroAddress, 1, "", id())).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    await expect(vault.connect(owner).pay(await vault.getAddress(), 1, "", id())).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    await expect(vault.connect(owner).pay(owner.address, 1, "", id())).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    await expect(vault.connect(owner).pay(recipient.address, 1, "", ethers.ZeroHash)).to.be.revertedWithCustomError(vault, "InvalidRequestId");
    await expect(vault.connect(owner).pay(recipient.address, 1, "😀".repeat(36), id())).to.be.revertedWithCustomError(vault, "MemoTooLong");
  });

  it("enforces exact permission expiry and request deadline boundaries", async function () {
    const { owner, agent, recipient, vault, now } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    await vault.connect(owner).grantAgent(agent.address, one, one, now + 100n, []);
    await networkHelpers.time.increaseTo(Number(now + 100n));
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1, "", id(), 1, now + 200n)).to.be.revertedWithCustomError(vault, "PermissionExpired");
    await vault.connect(owner).grantAgent(agent.address, one, one, now + 300n, []);
    await networkHelpers.time.increaseTo(Number(now + 201n));
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1, "", id(), 2, now + 200n)).to.be.revertedWithCustomError(vault, "RequestExpired");
  });

  it("prevents replay, and receiver rejection rolls back accounting and request usage", async function () {
    const { owner, agent, recipient, vault, now } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    await vault.connect(owner).grantAgent(agent.address, one, one, now + 3600n, []);
    const request = id();
    const rejecting = await ethers.deployContract("RejectingReceiver");
    await expect(vault.connect(agent).executeAgentPayment(owner.address, await rejecting.getAddress(), one / 4n, "", request, 1, now + 600n)).to.be.revertedWithCustomError(vault, "TransferFailed");
    expect(await vault.getBalance(owner.address)).to.equal(one);
    expect(await vault.totalLiabilities()).to.equal(one);
    expect((await vault.getAgentPermission(owner.address, agent.address)).remainingAllowance).to.equal(one);
    expect(await vault.usedRequestIds(owner.address, request)).to.equal(false);
    await vault.connect(agent).executeAgentPayment(owner.address, recipient.address, one / 4n, "", request, 1, now + 600n);
    await expect(vault.connect(agent).executeAgentPayment(owner.address, recipient.address, 1n, "", request, 1, now + 600n)).to.be.revertedWithCustomError(vault, "RequestUsed");
  });

  it("blocks reentrant withdrawal while allowing original withdrawal", async function () {
    const { vault } = await networkHelpers.loadFixture(fixture);
    const malicious = await ethers.deployContract("ReentrantReceiver", [await vault.getAddress()]);
    await malicious.depositToVault({ value: one });
    await malicious.withdrawFromVault(one / 2n);
    expect(await malicious.attempted()).to.equal(true);
    expect(await malicious.reentrySucceeded()).to.equal(false);
    expect(await vault.getBalance(await malicious.getAddress())).to.equal(one / 2n);
    expect(await vault.totalLiabilities()).to.equal(one / 2n);
  });

  it("permits forced ETH surplus without crediting liabilities", async function () {
    const { owner, vault } = await networkHelpers.loadFixture(fixture);
    await vault.connect(owner).deposit({ value: one });
    const force = await ethers.deployContract("ForceEther", { value: one / 2n });
    await force.force(await vault.getAddress());
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(one + one / 2n);
    expect(await vault.totalLiabilities()).to.equal(one);
    expect(await vault.getBalance(owner.address)).to.equal(one);
  });
});
