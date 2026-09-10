import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./test',workers:1,fullyParallel:false,timeout:30000,
  use:{baseURL:'http://127.0.0.1:5175',headless:true,viewport:{width:1440,height:1100}},
  webServer:[
    {command:'pnpm --filter @crypto-panel/api exec node --import tsx test/browser-server.ts',url:'http://127.0.0.1:3101/api/v1/workspace',reuseExistingServer:false,timeout:30000},
    {command:'pnpm exec vite --host 127.0.0.1 --port 5175',url:'http://127.0.0.1:5175',reuseExistingServer:false,
      env:{API_PROXY_TARGET:'http://127.0.0.1:3101'},timeout:30000},
  ],
});
