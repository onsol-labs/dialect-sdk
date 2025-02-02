import type {
  AddMembersCommand,
  CreateThreadCommand,
  FindThreadByIdQuery,
  FindThreadByOtherMemberQuery,
  FindThreadQuery,
  Messaging,
  SendMessageCommand,
  Thread,
  ThreadMember,
  ThreadMemberSummary,
  ThreadMessage,
  ThreadsGeneralSummary,
  ThreadSummary,
} from '../../messaging/messaging.interface';
import {
  ThreadId,
  ThreadMemberScope,
} from '../../messaging/messaging.interface';
import type {
  DataServiceDialectsApi,
  DialectAccountDto,
  DialectDto,
} from '../../dialect-cloud-api/data-service-dialects-api';
import { MemberScopeDto } from '../../dialect-cloud-api/data-service-dialects-api';
import type { DataServiceApiClientError } from '../../dialect-cloud-api/data-service-api';
import {
  IllegalStateError,
  ResourceNotFoundError,
  UnsupportedOperationError,
} from '../../sdk/errors';
import type { EncryptionKeysProvider } from '../../encryption/encryption-keys-provider';
import { withErrorParsing } from '../../dialect-cloud-api/data-service-errors';
import { ThreadAlreadyExistsError } from '../../messaging/errors';
import type { AccountAddress } from '../../auth/auth.interface';
import { Ed25519PublicKey } from '../../auth/ed25519/ed25519-public-key';
import type { EncryptionProps, TextSerde } from '../../messaging/text-serde';
import {
  EncryptedTextSerde,
  UnencryptedTextSerde,
} from '../../messaging/text-serde';
import { DIALECT_API_TYPE_DIALECT_CLOUD } from '../../sdk/constants';

export class DataServiceMessaging implements Messaging {
  readonly type = DIALECT_API_TYPE_DIALECT_CLOUD;

  constructor(
    private readonly me: AccountAddress,
    private readonly dataServiceDialectsApi: DataServiceDialectsApi,
    private readonly encryptionKeysProvider: EncryptionKeysProvider,
  ) {}

  async create(command: CreateThreadCommand): Promise<Thread> {
    const otherMembers = requireAtLeastOneMember(command.otherMembers);
    if (command.encrypted && otherMembers.length >= 2) {
      throw new UnsupportedOperationError(
        'Unsupported operation',
        'Encryption not supported in group chats',
      );
    }
    command.encrypted && (await this.checkEncryptionSupported());
    const dialectAccountDto = await withErrorParsing(
      this.dataServiceDialectsApi.create({
        encrypted: command.encrypted,
        members: [
          {
            address: this.me,
            scopes: toDataServiceScopes(command.me.scopes),
          },
          ...otherMembers.map((e) => ({
            address: e.address,
            scopes: toDataServiceScopes(e.scopes),
          })),
        ],
      }),
      () => new ThreadAlreadyExistsError(),
    );
    return this.toDataServiceThread(dialectAccountDto);
  }

  async find(query: FindThreadQuery): Promise<Thread | null> {
    const dialectAccountDto = await this.findInternal(query);
    return dialectAccountDto && this.toDataServiceThread(dialectAccountDto);
  }

  async findAll(): Promise<Thread[]> {
    const dialectAccountDtos = await withErrorParsing(
      this.dataServiceDialectsApi.findAll(),
    );
    return Promise.all(
      dialectAccountDtos.map((it) => this.toDataServiceThread(it)),
    );
  }

  async findSummary(
    query: FindThreadByOtherMemberQuery,
  ): Promise<ThreadSummary | null> {
    try {
      const dialectSummaryDto = await withErrorParsing(
        this.dataServiceDialectsApi.findSummary({
          memberAddresses: [
            this.me.toString(),
            ...query.otherMembers.map((it) => it.toString()),
          ],
        }),
      );
      const meMember = dialectSummaryDto.memberSummaries.find(
        (it) => it.address === this.me,
      );
      if (!meMember) {
        throw new IllegalStateError(
          `Cannot resolve member from given list: ${dialectSummaryDto.memberSummaries.map(
            (it) => it.address,
          )} and provided member public key ${this.me.toString()}`,
        );
      }
      const meMemberSummary: ThreadMemberSummary = {
        address: meMember.address,
        hasUnreadMessages: meMember.hasUnreadMessages,
        unreadMessagesCount: meMember.unreadMessagesCount,
      };
      return {
        id: new ThreadId({
          address: dialectSummaryDto.id,
          type: this.type,
        }),
        me: meMemberSummary,
      };
    } catch (e) {
      const err = e as DataServiceApiClientError;
      if (err instanceof ResourceNotFoundError) return null;
      throw e;
    }
  }

  async findSummaryAll(): Promise<ThreadsGeneralSummary> {
    return await withErrorParsing(
      this.dataServiceDialectsApi.findSummaryAll({
        address: this.me,
      }),
    );
  }

  private checkEncryptionSupported() {
    return this.encryptionKeysProvider.getFailFast(this.me);
  }

  private async toDataServiceThread(dialectAccountDto: DialectAccountDto) {
    const { id, dialect } = dialectAccountDto;
    const meMember = findMember(this.me, dialect);
    const otherMembers = findOtherMembers(this.me, dialect);
    if (!meMember || !otherMembers.length) {
      throw new IllegalStateError(
        `Cannot resolve members from given list: ${dialect.members.map(
          (it) => it.address,
        )} and wallet public key ${this.me.toString()}`,
      );
    }
    const { serde, canBeDecrypted } = await this.createTextSerde(dialect);
    const otherThreadMembers: ThreadMember[] = otherMembers.map((member) => ({
      address: member.address,
      scopes: fromDataServiceScopes(member.scopes),
      // lastReadMessageTimestamp: new Date(), // TODO: implement
    }));
    const otherMembersPks = Object.fromEntries(
      otherThreadMembers.map((member) => [member.address.toString(), member]),
    );

    const thisThreadMember: ThreadMember = {
      address: meMember.address,
      scopes: fromDataServiceScopes(meMember.scopes),
      // lastReadMessageTimestamp: new Date(), // TODO: implement
    };
    const lastMessage = dialect.lastMessage ?? null;
    let lastThreadMessage: ThreadMessage | null = null;
    if (lastMessage != null) {
      lastThreadMessage = {
        text: serde.deserialize(new Uint8Array(lastMessage.text)),
        timestamp: new Date(lastMessage.timestamp),
        author:
          lastMessage.owner === this.me
            ? thisThreadMember
            : otherMembersPks[lastMessage.owner]!,
        deduplicationId: lastMessage.deduplicationId,
      };
    }

    return new DataServiceThread(
      this.dataServiceDialectsApi,
      serde,
      this.encryptionKeysProvider,
      id,
      thisThreadMember,
      otherThreadMembers,
      otherMembersPks,
      dialect.encrypted,
      canBeDecrypted,
      new Date(dialect.updatedAt),
      lastThreadMessage,
      dialect.groupName,
    );
  }

  private async createTextSerde(dialect: DialectDto): Promise<{
    serde: TextSerde;
    canBeDecrypted: boolean;
  }> {
    if (!dialect.encrypted) {
      return {
        serde: new UnencryptedTextSerde(),
        canBeDecrypted: true,
      };
    }
    const diffieHellmanKeyPair = await this.encryptionKeysProvider.getFailSafe(
      this.me,
    );
    const encryptionProps: EncryptionProps | null = diffieHellmanKeyPair && {
      diffieHellmanKeyPair,
      ed25519PublicKey: new Ed25519PublicKey(this.me).toBytes(),
    };
    if (!encryptionProps) {
      return {
        serde: new UnencryptedTextSerde(),
        canBeDecrypted: false,
      };
    }
    return {
      serde: new EncryptedTextSerde(
        encryptionProps,
        dialect.members.map((it) => new Ed25519PublicKey(it.address)),
      ),
      canBeDecrypted: true,
    };
  }

  private findInternal(
    query: FindThreadByIdQuery | FindThreadByOtherMemberQuery,
  ) {
    if ('id' in query) {
      return this.findById(query);
    }
    return this.findByOtherMember(query);
  }

  private async findById(query: FindThreadByIdQuery) {
    try {
      return await withErrorParsing(
        this.dataServiceDialectsApi.find(query.id.address.toString()),
      );
    } catch (e) {
      const err = e as DataServiceApiClientError;
      if (err instanceof ResourceNotFoundError) return null;
      throw e;
    }
  }

  private async findByOtherMember(query: FindThreadByOtherMemberQuery) {
    const otherMembers = requireAtLeastOneMember(query.otherMembers);
    try {
      return await withErrorParsing(
        this.dataServiceDialectsApi.findByMembers({
          memberAddresses: otherMembers.map((member) => member.toString()),
        }),
      );
    } catch (e) {
      const err = e as DataServiceApiClientError;
      if (err instanceof ResourceNotFoundError) return null;
      throw e;
    }
  }
}

export class DataServiceThread implements Thread {
  readonly type = DIALECT_API_TYPE_DIALECT_CLOUD;
  readonly id: ThreadId;

  constructor(
    private readonly dataServiceDialectsApi: DataServiceDialectsApi,
    private readonly textSerde: TextSerde,
    private readonly encryptionKeysProvider: EncryptionKeysProvider,
    private readonly address: AccountAddress,
    readonly me: ThreadMember,
    readonly otherMembers: ThreadMember[],
    private readonly otherMembersPks: Record<string, ThreadMember>,
    readonly encryptionEnabled: boolean,
    readonly canBeDecrypted: boolean,
    public updatedAt: Date,
    public lastMessage: ThreadMessage | null,
    public name?: string,
  ) {
    this.id = new ThreadId({
      type: this.type,
      address,
    });
  }

  async delete(): Promise<void> {
    await withErrorParsing(
      this.dataServiceDialectsApi.delete(this.address.toString()),
    );
  }

  async messages(): Promise<ThreadMessage[]> {
    const { dialect } = await withErrorParsing(
      this.dataServiceDialectsApi.find(this.address.toString()),
    );
    this.updatedAt = new Date(dialect.updatedAt);
    if (this.encryptionEnabledButCannotBeUsed()) {
      return [];
    }
    const { messages } = await withErrorParsing(
      this.dataServiceDialectsApi.getMessages(this.address.toString()),
    );
    const threadMessages = messages.map((it) => ({
      author:
        it.owner === this.me.address.toString()
          ? this.me
          : this.otherMembersPks[it.owner]!,
      timestamp: new Date(it.timestamp),
      text: this.textSerde.deserialize(new Uint8Array(it.text)),
      deduplicationId: it.deduplicationId,
    }));
    this.lastMessage = threadMessages[0] ?? null;
    return threadMessages;
  }

  async send(command: SendMessageCommand): Promise<void> {
    if (this.encryptionEnabledButCannotBeUsed()) {
      throw new UnsupportedOperationError(
        'Encryption not supported',
        'Please use encryption keys provider that supports encryption.',
      );
    }
    await withErrorParsing(
      this.dataServiceDialectsApi.sendMessage(this.address.toString(), {
        text: Array.from(this.textSerde.serialize(command.text)),
        deduplicationId: command.deduplicationId,
      }),
    );
  }

  async markAsRead(): Promise<void> {
    await withErrorParsing(
      this.dataServiceDialectsApi.markAsRead(this.id.address.toString()),
    );
  }

  async addMembers(command: AddMembersCommand): Promise<void> {
    const members = requireAtLeastOneMember(command.members);
    await withErrorParsing(
      this.dataServiceDialectsApi.addMembers(this.id.address.toString(), {
        members: members.map((e) => ({
          address: e.address,
          scopes: toDataServiceScopes(e.scopes),
        })),
      }),
      () => new ThreadAlreadyExistsError(),
    );
  }

  async removeMember(address: AccountAddress): Promise<void> {
    await withErrorParsing(
      this.dataServiceDialectsApi.removeMember(
        this.id.address.toString(),
        address,
      ),
      () => new ThreadAlreadyExistsError(),
    );
  }

  async rename(name: string): Promise<void> {
    await withErrorParsing(
      this.dataServiceDialectsApi.patch(this.id.address.toString(), {
        groupName: name,
      }),
    );
  }

  private encryptionEnabledButCannotBeUsed() {
    return this.encryptionEnabled && !this.canBeDecrypted;
  }
}

function fromDataServiceScopes(scopes: MemberScopeDto[]) {
  return scopes.map((it) => ThreadMemberScope[it]);
}

function toDataServiceScopes(scopes: ThreadMemberScope[]) {
  return scopes.map((it) => MemberScopeDto[it]);
}

function findMember(memberPk: AccountAddress, dialect: DialectDto) {
  return dialect.members.find((it) => memberPk === it.address) ?? null;
}

function findOtherMembers(memberPk: AccountAddress, dialect: DialectDto) {
  return dialect.members.filter((it) => memberPk !== it.address);
}

function requireAtLeastOneMember<T>(members: T[]) {
  if (members.length < 1) {
    throw new UnsupportedOperationError(
      'Unsupported operation',
      'At least one member should be specified',
    );
  }
  return members;
}
