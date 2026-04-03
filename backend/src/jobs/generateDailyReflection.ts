import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

import { DatabaseService } from '../services/databaseService';
import { DailyReflectionService, getAnalyticsTimezone } from '../services/dailyReflectionService';

async function main() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();
  const reflectionService = new DailyReflectionService(databaseService);
  const date = process.argv[2];
  const timezone = process.env.ANALYTICS_TIMEZONE || getAnalyticsTimezone();
  const reflection = await reflectionService.generateReflection(date, timezone);
  console.log(
    JSON.stringify(
      {
        reflectionDate: reflection.reflectionDate,
        timezone: reflection.timezone,
        scorecard: reflection.scorecard,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('Failed to generate daily reflection', error);
  process.exitCode = 1;
});
