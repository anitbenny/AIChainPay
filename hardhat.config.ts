import "dotenv/config";
import { defineConfig, configVariable } from "hardhat/config";
import toolbox from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

export default defineConfig({
  plugins: [toolbox],
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    localhost: { type: "http", chainType: "l1", chainId: 31337, url: "http://127.0.0.1:8545" },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
