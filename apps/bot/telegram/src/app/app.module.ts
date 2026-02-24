import { Module } from '@nestjs/common';
import { DatabaseModule } from '@org/database';

@Module({
  imports: [DatabaseModule],
})
export class AppModule {}