import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChromeCatalogUserDto {
  @ApiProperty({ example: 's7xmrobins', description: 'DealerSocket user login username / value' })
  value!: string;

  @ApiProperty({ example: 'Matt Robinson', description: 'DealerSocket user display text / name' })
  text!: string;
}

export class ChromeCatalogFranchiseDto {
  @ApiProperty({ example: 1, description: 'Franchise key (1 for New, 2 for Used)' })
  key!: number | string;

  @ApiProperty({ example: 'South Morang Hyundai', description: 'Franchise name' })
  value!: string;
}

export class ChromeCatalogDto {
  @ApiProperty({ example: '10876', description: 'Verified DealerSocket dealership site ID' })
  siteId!: string;

  @ApiProperty({ example: 'South Morang Hyundai', description: 'Dealership name' })
  name!: string;

  @ApiProperty({ type: [ChromeCatalogUserDto], description: 'List of assignable sales and general managers' })
  users!: ChromeCatalogUserDto[];

  @ApiProperty({ type: [ChromeCatalogFranchiseDto], description: 'Verified dealership franchises' })
  franchises!: ChromeCatalogFranchiseDto[];
}

export class ChromeSnapshotRecordDto {
  @ApiProperty({ example: '10876', description: 'Dealership ID' })
  dealership_id!: string;

  @ApiProperty({ example: 'South Morang Hyundai', description: 'Rooftop name' })
  rooftop!: string;

  @ApiPropertyOptional({ example: '293847', description: 'DealerSocket Lead ID' })
  lead_id?: string;

  @ApiPropertyOptional({ example: 'John', description: 'Customer first name' })
  first_name?: string;

  @ApiPropertyOptional({ example: 'Doe', description: 'Customer last name' })
  last_name?: string;

  @ApiPropertyOptional({ example: '+61412345678', description: 'Mobile phone number' })
  mobile?: string;

  @ApiPropertyOptional({ example: '2026-11-03T05:00:00Z', description: 'Observation timestamp' })
  created_at?: string;
}

export class ChromeSnapshotDto {
  @ApiProperty({ example: 'south_morang_hyundai', description: 'Verified rooftop scope' })
  scope!: string;

  @ApiProperty({ example: true, description: 'Read-only marker' })
  readOnly!: boolean;

  @ApiProperty({ type: [ChromeSnapshotRecordDto], description: 'Observed DealerSocket lead records' })
  records!: ChromeSnapshotRecordDto[];

  @ApiPropertyOptional({ example: '2026-11-03T05:00:00Z', description: 'Snapshot generation time' })
  fetchedAt?: string;
}

export class ChromeClaimJobDto {
  @ApiPropertyOptional({ example: true, description: 'Whether the Chrome worker tab is currently authenticated' })
  authenticated?: boolean;
}

export class ChromeJobResultDto {
  @ApiProperty({
    enum: ['synced', 'needs_review', 'needs_match'],
    example: 'synced',
    description: 'Outcome of CRM job execution',
  })
  state!: 'synced' | 'needs_review' | 'needs_match';

  @ApiPropertyOptional({ example: '984321', description: 'Created DealerSocket opportunity ID if synced' })
  opportunityId?: string;

  @ApiPropertyOptional({ example: '54321', description: 'Matched DealerSocket contact ID' })
  contactId?: string;
}

export class LinkCustomerDto {
  @ApiProperty({ example: '54321', description: 'DealerSocket customer contact ID (numeric string)' })
  contactId!: string;
}

export class SaveRoutingDto {
  @ApiProperty({ example: 's7xqtruong', description: 'Primary assignee username (Sales Manager)' })
  salesManager!: string;

  @ApiProperty({ example: 's7xmrobins', description: 'Secondary assignee username (General Manager)' })
  generalManager!: string;
}

export class ContactRowDto {
  @ApiProperty({ example: '0412345678', description: 'Australian mobile number' })
  mobile!: string;

  @ApiPropertyOptional({ example: 'Jane', description: 'First name' })
  firstName?: string;

  @ApiPropertyOptional({ example: 'Smith', description: 'Last name' })
  lastName?: string;

  @ApiProperty({ enum: ['express', 'inferred'], example: 'express', description: 'Spam Act consent classification' })
  consent!: 'express' | 'inferred';

  @ApiProperty({ example: 'Purchased Hyundai Tucson Aug 2025; consented to SMS follow-up', description: 'Consent audit trail' })
  evidence!: string;

  @ApiPropertyOptional({ example: '54321', description: 'Optional pre-matched DealerSocket contact ID' })
  dealerSocketContactId?: string;
}

export class ImportContactsDto {
  @ApiProperty({ type: [ContactRowDto], description: 'List of contacts to import (max 10,000)' })
  rows!: ContactRowDto[];
}

export class ImportWorkbookDto {
  @ApiProperty({ description: 'Base64-encoded XLSX workbook content (max 5 MB)' })
  base64!: string;
}

export class SuppressionDto {
  @ApiProperty({ example: '+61412345678', description: 'Australian mobile number to suppress' })
  mobile!: string;
}

export class CreateCampaignDto {
  @ApiProperty({ example: 'November Loyalty Offer', description: 'Campaign title for operator reference' })
  name!: string;

  @ApiProperty({
    example: 'Booran South Morang Hyundai: Exclusive loyalty offer for valued customers. Explore yours: {link} {optout}',
    description: 'SMS message body containing Booran identifier, {link} shortlink tag, and {optout} tag',
  })
  body!: string;
}

export class CaptureLeadDto {
  @ApiPropertyOptional({ description: 'Permission to respond, confirmed on the loyalty form' })
  contactConsent?: boolean;

  @ApiPropertyOptional({ description: 'Existing customer eligibility confirmed on the form' })
  existingCustomer?: boolean;
  @ApiProperty({ example: '+61412345678', description: 'Customer mobile number' })
  mobile!: string;

  @ApiProperty({ example: 'Sarah', description: 'Customer first name' })
  firstName!: string;

  @ApiPropertyOptional({ example: 'Connor', description: 'Customer last name' })
  lastName?: string;

  @ApiPropertyOptional({ example: 'sarah.connor@example.com', description: 'Customer email address' })
  email?: string;

  @ApiProperty({ example: 'evt_984729104', description: 'Unique submission event ID' })
  eventId!: string;

  @ApiPropertyOptional({ example: '3f8e5f1b-4b2a-4a2a-8b1a-1c2d3e4f5a6b', description: 'Campaign originating token' })
  token?: string;

  @ApiPropertyOptional({ example: '123456', description: 'Existing DealerSocket contact ID if known' })
  dealerSocketContactId?: string;
}

export class MobileMessageWebhookDto {
  @ApiPropertyOptional({ example: 'unsubscribe', description: 'Webhook event type (inbound, unsubscribe, delivery)' })
  type?: string;

  @ApiPropertyOptional({ example: '+61412345678', description: 'Originating mobile number' })
  sender?: string;

  @ApiPropertyOptional({ example: 'STOP', description: 'Inbound message text' })
  message?: string;

  @ApiPropertyOptional({ example: 'msg_872364823', description: 'Provider message ID' })
  message_id?: string;

  @ApiPropertyOptional({ enum: ['delivered', 'failed'], example: 'delivered', description: 'Delivery receipt status' })
  status?: string;

  @ApiPropertyOptional({ example: 1, description: 'Multipart segment index' })
  part_number?: number;

  @ApiPropertyOptional({ example: 1, description: 'Total multipart segments' })
  total_parts?: number;

  @ApiPropertyOptional({ example: '2026-11-03T05:00:00Z', description: 'Provider delivery timestamp' })
  received_at?: string;

  @ApiPropertyOptional({ example: '3f8e5f1b-4b2a-4a2a-8b1a-1c2d3e4f5a6b', description: 'Internal message ID' })
  custom_ref?: string;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', description: 'Health check status' })
  status!: string;
}

