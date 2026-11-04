import { defineConfig } from '@playwright/test'
export default defineConfig({testDir:'./e2e',fullyParallel:false,workers:1,timeout:60_000,retries:0,reporter:'list',use:{headless:true,trace:'off',video:'off',screenshot:'off'},outputDir:'../test-results/web'})
