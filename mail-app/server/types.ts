// Shared shapes used by the HTTP API, the MCP server, and both mail providers.

export interface Address {
  name?: string;
  address: string;
}

export interface Folder {
  path: string;
  name: string;
  /** Special-use role, e.g. "inbox", "sent", "drafts", "trash", "junk", "archive". */
  role?: string;
  unread?: number;
  total?: number;
}

export interface MessageSummary {
  uid: number;
  folder: string;
  messageId?: string;
  subject: string;
  from?: Address;
  to: Address[];
  date: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  preview: string;
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface Message extends MessageSummary {
  cc: Address[];
  replyTo: Address[];
  references: string[];
  text: string;
  html?: string;
  attachments: AttachmentInfo[];
}

export interface ListOptions {
  folder: string;
  /** 1-based page number. */
  page?: number;
  pageSize?: number;
  search?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
}

export interface ListResult {
  folder: string;
  total: number;
  page: number;
  pageSize: number;
  messages: MessageSummary[];
}

export interface OutgoingAttachment {
  filename: string;
  contentType?: string;
  /** Base64-encoded file content. */
  content: string;
}

export interface SendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface AttachmentData {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface MailProvider {
  readonly account: Address;
  listFolders(): Promise<Folder[]>;
  listMessages(opts: ListOptions): Promise<ListResult>;
  getMessage(folder: string, uid: number): Promise<Message | null>;
  getAttachment(folder: string, uid: number, index: number): Promise<AttachmentData | null>;
  setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  move(folder: string, uid: number, target: string): Promise<void>;
  /** Moves to Trash, or expunges when already in Trash. */
  remove(folder: string, uid: number): Promise<void>;
  send(req: SendRequest): Promise<SendResult>;
  close(): Promise<void>;
}
