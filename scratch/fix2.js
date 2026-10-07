const fs = require('fs');

function addImportIfMissing(file, importStatement) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes(importStatement)) {
    content = importStatement + '\n' + content;
    fs.writeFileSync(file, content);
  }
}

addImportIfMissing('src/modules/analyzer/analyzerService.ts', "import { logger } from '../../utils/logger';");
addImportIfMissing('src/modules/security/honeypotSimulator.ts', "import { logger } from '../../utils/logger';");
// router.ts already imports logger, wait let's check
let router = fs.readFileSync('src/modules/telegram/router.ts', 'utf8');
if (!router.includes("import { logger }")) {
  router = "import { logger } from '../../utils/logger';\n" + router;
}
router = router.replace(/await import\('\.\.\/\.\.\/database\/client'\)/g, "await import('../../database/client.js')");
router = router.replace(/await import\('\.\.\/\.\.\/database\/repositories\/walletRepository'\)/g, "await import('../../database/repositories/walletRepository.js')");
router = router.replace(/await import\('\.\.\/scanner\/trendScanner'\)/g, "await import('../scanner/trendScanner.js')");
fs.writeFileSync('src/modules/telegram/router.ts', router);

let walletHandler = fs.readFileSync('src/modules/telegram/handlers/walletHandler.ts', 'utf8');
walletHandler = walletHandler.replace(/await import\('\.\.\/\.\.\/\.\.\/database\/client'\)/g, "await import('../../../database/client.js')");
walletHandler = walletHandler.replace(/await import\('\.\.\/\.\.\/\.\.\/database\/repositories\/walletRepository'\)/g, "await import('../../../database/repositories/walletRepository.js')");
walletHandler = walletHandler.replace(/await import\('\.\.\/\.\.\/\.\.\/queue\/connection'\)/g, "await import('../../../queue/connection.js')");
fs.writeFileSync('src/modules/telegram/handlers/walletHandler.ts', walletHandler);

// trendScanner bot import needs to be .js? Wait, the previous import was '../../telegram/bot.js'.
// Error: Cannot find module '../../telegram/bot.js' or its corresponding type declarations.
// That's because the original file is 'bot.ts', so we shouldn't use .js for the import type checking?
// Wait, for `await import` with 'nodenext', we DO use '.js'. Why did it error on bot.js?
// Ah! The original file is `src/modules/telegram/bot.ts`.
// From `src/modules/scanner/trendScanner.ts`, the path is `../telegram/bot.js`.
// Wait, `trendScanner` is in `src/modules/scanner/`. `telegram` is in `src/modules/telegram/`.
// So the path is `../telegram/bot.js`. My script used `../../telegram/bot.js` which is ONE DIRECTORY TOO HIGH!
let trendScanner = fs.readFileSync('src/modules/scanner/trendScanner.ts', 'utf8');
trendScanner = trendScanner.replace(/await import\('\.\.\/\.\.\/telegram\/bot\.js'\)/g, "await import('../telegram/bot.js')");
fs.writeFileSync('src/modules/scanner/trendScanner.ts', trendScanner);

console.log('Fixed TS errors!');
