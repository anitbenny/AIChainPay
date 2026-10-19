import type Database from "better-sqlite3";
import type { ChainService } from "./index.js";
import type { Config } from "../config.js";

export class PaymentIndexer {
  private running: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: Database.Database, private readonly config: Config, private readonly chain: ChainService) {}

  sync(maxRanges = 3): Promise<{ indexedThrough: number; latestBlock: number; complete: boolean }> {
    const work = this.running.then(() => this.syncNow(maxRanges), () => this.syncNow(maxRanges));
    this.running = work.then(() => undefined, () => undefined);
    return work;
  }

  private async syncNow(maxRanges: number) {
    await this.chain.check();
    const latestBlock = await this.chain.provider.getBlockNumber();
    const prior = this.db.prepare("SELECT next_block FROM index_cursors WHERE chain_id=? AND contract_address=?").get(this.config.chainId, this.config.contractAddress) as { next_block: number } | undefined;
    let nextBlock = prior ? Math.max(this.config.deploymentBlock, prior.next_block - 12) : this.config.deploymentBlock;
    // Rescan a short overlap for shallow reorgs. Remove and reinsert exactly that range.
    const event = this.chain.iface.getEvent("PaymentExecuted");
    if (!event) throw new Error("PaymentExecuted ABI missing");
    const topic = event.topicHash;
    let ranges = 0;
    while (nextBlock <= latestBlock && ranges < maxRanges) {
      const end = Math.min(latestBlock, nextBlock + 999);
      const logs = await this.chain.provider.getLogs({ address: this.config.contractAddress, topics: [topic], fromBlock: nextBlock, toBlock: end });
      const parsed = logs.map(log => {
        const item = this.chain.iface.parseLog(log);
        if (!item || item.name !== "PaymentExecuted") throw new Error("Unexpected payment event log");
        return { log, args: item.args };
      });
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM payment_events WHERE chain_id=? AND lower(contract_address)=lower(?) AND block_number BETWEEN ? AND ?").run(this.config.chainId, this.config.contractAddress, nextBlock, end);
        const insert = this.db.prepare("INSERT OR REPLACE INTO payment_events(tx_hash,log_index,chain_id,contract_address,block_number,block_hash,owner,recipient,request_id,payment_id,executor,amount_wei,memo,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const { log, args } of parsed) insert.run(log.transactionHash, log.index, this.config.chainId, this.config.contractAddress, log.blockNumber, log.blockHash, args.owner, args.recipient, args.requestId, args.paymentId.toString(), args.executor, args.amount.toString(), args.memo, Number(args.timestamp));
        this.db.prepare("INSERT INTO index_cursors(chain_id,contract_address,next_block) VALUES(?,?,?) ON CONFLICT(chain_id,contract_address) DO UPDATE SET next_block=excluded.next_block").run(this.config.chainId, this.config.contractAddress, end + 1);
      })();
      nextBlock = end + 1;
      ranges++;
    }
    return { indexedThrough: nextBlock - 1, latestBlock, complete: nextBlock > latestBlock };
  }

  recentFor(address: string, cursor: number, limit: number) {
    const rows = this.db.prepare("SELECT tx_hash,log_index,block_number,owner,recipient,request_id,payment_id,executor,amount_wei,memo,timestamp FROM payment_events WHERE chain_id=? AND lower(contract_address)=lower(?) AND (lower(owner)=lower(?) OR lower(recipient)=lower(?)) ORDER BY block_number DESC,log_index DESC LIMIT ? OFFSET ?")
      .all(this.config.chainId, this.config.contractAddress, address, address, limit + 1, cursor) as { tx_hash: string; log_index: number; block_number: number; owner: string; recipient: string; request_id: string; payment_id: string; executor: string; amount_wei: string; memo: string; timestamp: number }[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(row => ({ ...row, explorer_url: this.config.chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${row.tx_hash}` : null })), nextCursor: hasMore ? cursor + limit : null };
  }
}
