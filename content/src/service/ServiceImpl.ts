import { ContentStorage } from "../storage/ContentStorage";
import { FileHash, Hashing } from "./Hashing";
import { EntityType, Pointer, EntityId, Entity } from "./Entity";
import { Validation } from "./Validation";
import { Service, EthAddress, Signature, Timestamp, ENTITY_FILE_NAME, AuditInfo, File, ServerStatus } from "./Service";
import { EntityFactory } from "./EntityFactory";
import { HistoryManager } from "./history/HistoryManager";
import { NameKeeper, ServerName } from "./naming/NameKeeper";
import { ContentAnalytics } from "./analytics/ContentAnalytics";
import { PointerManager, CommitResult } from "./pointers/PointerManager";

export class ServiceImpl implements Service {

    private entities: Map<EntityId, Entity> = new Map();

    constructor(
        private storage: ContentStorage,
        private historyManager: HistoryManager,
        private pointerManager: PointerManager,
        private nameKeeper: NameKeeper,
        private analytics: ContentAnalytics,
        private ignoreValidationErrors: boolean = false) {
    }

    getEntitiesByPointers(type: EntityType, pointers: Pointer[]): Promise<Entity[]> {
        return Promise.all(pointers
            .map((pointer: Pointer) => this.pointerManager.getEntityInPointer(type, pointer)))
            .then((entityIds:(EntityId|undefined)[]) => entityIds.filter(entity => entity !== undefined))
            .then(entityIds => this.getEntitiesByIds(type, entityIds as EntityId[]))
    }

    getEntitiesByIds(type: EntityType, ids: EntityId[]): Promise<Entity[]> {
        return Promise.all(ids
            .filter((elem, pos, array) => array.indexOf(elem) == pos) // Removing duplicates. Quickest way to do so.
            .map((entityId: EntityId) => this.getEntityById(entityId)))
            .then((entities:(Entity|undefined)[]) => entities.filter(entity => entity !== undefined)) as Promise<Entity[]>
    }

    private async getEntityById(id: EntityId): Promise<Entity | undefined> {
        let entity = this.entities.get(id)
        if (!entity) {
            // Try to get the entity from the storage
            try {
                const buffer = await this.storage.getContent(StorageCategory.CONTENTS, id)
                entity = EntityFactory.fromBufferWithId(buffer, id)
                this.entities.set(id, entity)
            } catch (error) { }
        }
        return entity
    }

    getActivePointers(type: EntityType): Promise<Pointer[]> {
        return this.pointerManager.getActivePointers(type)
    }

    async deployEntity(files: File[], entityId: EntityId, ethAddress: EthAddress, signature: Signature): Promise<Timestamp> {
        return this.deployEntityWithServerAndTimestamp(files, entityId, ethAddress, signature, this.nameKeeper.getServerName(), Date.now, true)
    }

    async deployEntityFromAnotherContentServer(files: File[], entityId: EntityId, ethAddress: EthAddress, signature: Signature, serverName: ServerName, deploymentTimestamp: Timestamp): Promise<void> {
        await this.deployEntityWithServerAndTimestamp(files, entityId, ethAddress, signature, serverName, () => deploymentTimestamp, false)
    }

    // TODO: Maybe move this somewhere else?
    private async deployEntityWithServerAndTimestamp(files: File[], entityId: EntityId, ethAddress: EthAddress, signature: Signature, serverName: ServerName, timestampCalculator: () => Timestamp, checkFreshness: Boolean): Promise<Timestamp> {
        // Find entity file and make sure its hash is the expected
        const entityFile: File = this.findEntityFile(files)
        if (entityId !== await Hashing.calculateHash(entityFile)) {
            throw new Error("Entity file's hash didn't match the signed entity id.")
        }

        const validation = new Validation()
        // Validate signature
        await validation.validateSignature(entityId, ethAddress, signature)

        // Validate request size
        validation.validateRequestSize(files)

        // Parse entity file into an Entity
        const entity: Entity = EntityFactory.fromFile(entityFile, entityId)

        // Validate entity
        validation.validateEntity(entity)

        // Validate ethAddress access
        validation.validateAccess(entity.pointers, ethAddress, entity.type)

        if (checkFreshness) {
            // Validate that the entity is "fresh"
            await validation.validateFreshDeployment(entity, (type,pointers) => this.getEntitiesByPointers(type, pointers))
        }

        // Type validation
        validation.validateType(entity)

        // Hash all files, and validate them
        const hashes: Map<FileHash, File> = await Hashing.calculateHashes(files)
        const alreadyStoredHashes: Map<FileHash, Boolean> = await this.isContentAvailable(Array.from(hashes.keys()));
        validation.validateHashes(entity, hashes, alreadyStoredHashes)

        if (!this.ignoreValidationErrors && validation.getErrors().length > 0) {
            throw new Error(validation.getErrors().join('\n'))
        }

        // IF THIS POINT WAS REACHED, THEN THE DEPLOYMENT WILL BE COMMITED

        const commitResult: CommitResult = await this.pointerManager.tryToCommitPointers(entity);

        // Delete entities that the new deployment would overwrite
        commitResult.entitiesDeleted.forEach((entityId: EntityId) => this.entities.delete(entityId))

        // Store the entity's content
        await this.storeEntityContent(hashes, alreadyStoredHashes, entityId, commitResult.couldCommit)

        // Calculate timestamp
        const deploymentTimestamp: Timestamp = timestampCalculator()

        // Save audit information
        const auditInfo: AuditInfo = {
            deployedTimestamp: deploymentTimestamp,
            ethAddress: ethAddress,
            signature: signature,
        }
        await this.storage.store(this.resolveCategory(StorageCategory.PROOFS), entity.id, Buffer.from(JSON.stringify(auditInfo)))

        // Add the new deployment to history
        await this.historyManager.newEntityDeployment(serverName, entity, deploymentTimestamp)

        // Record deployment for analytics
        this.analytics.recordDeployment(this.nameKeeper.getServerName(), entity, ethAddress)

        return Promise.resolve(deploymentTimestamp)
    }

    private storeEntityContent(hashes: Map<FileHash, File>, alreadyStoredHashes: Map<FileHash, Boolean>, entityId: EntityId, couldCommit: boolean): Promise<any> {
        if (couldCommit) {
            // If entity was commited, then store all it's content (that isn't already stored)
            const contentStorageActions: Promise<void>[] = Array.from(hashes.entries())
                .filter(([fileHash, file]) => !alreadyStoredHashes.get(fileHash))
                .map(([fileHash, file]) => this.storage.store(this.resolveCategory(StorageCategory.CONTENTS), fileHash, file.content))

            return Promise.all(contentStorageActions)
        } else {
            // If entity wasn't commited, then only store the entity file
            if (!alreadyStoredHashes.get(entityId)) {
                const entityFile: File = hashes.get(entityId) as File
                return this.storage.store(this.resolveCategory(StorageCategory.CONTENTS), entityId, entityFile.content)
            } else {
                return Promise.resolve()
            }
        }
    }

    private findEntityFile(files: File[]): File {
        const filesWithName = files.filter(file => file.name === ENTITY_FILE_NAME)
        if (filesWithName.length === 0) {
            throw new Error(`Failed to find the entity file. Please make sure that it is named '${ENTITY_FILE_NAME}'.`)
        } else if (filesWithName.length > 1) {
            throw new Error(`Found more than one file called '${ENTITY_FILE_NAME}'. Please make sure you upload only one with that name.`)
        }

        return filesWithName[0];
    }

    getContent(fileHash: FileHash): Promise<Buffer> {
        // TODO: Catch potential exception if content doesn't exist, and return better error message
        return this.storage.getContent(this.resolveCategory(StorageCategory.CONTENTS), fileHash);
    }

    getAuditInfo(type: EntityType, id: EntityId): Promise<AuditInfo> {
        // TODO: Catch potential exception if content doesn't exist, and return better error message
        return this.storage.getContent(this.resolveCategory(StorageCategory.PROOFS), id)
        .then(buffer => JSON.parse(buffer.toString()))
    }

    async isContentAvailable(fileHashes: FileHash[]): Promise<Map<FileHash, Boolean>> {
        const contentsAvailableActions: Promise<[FileHash, Boolean]>[] = fileHashes.map((fileHash: FileHash) =>
            this.storage.exists(this.resolveCategory(StorageCategory.CONTENTS), fileHash)
                .then(exists => [fileHash, exists]))

        return new Map(await Promise.all(contentsAvailableActions));
    }

    /** Resolve a category name, based on the storage category and the entity's type */
    private resolveCategory(storageCategory: StorageCategory, type?: EntityType): string {
        return storageCategory + (storageCategory === StorageCategory.POINTERS && type ? `-${type}` : "")
    }

    getStatus(): Promise<ServerStatus> {
        return Promise.resolve({
            name: this.nameKeeper.getServerName(),
            version: "1.0",
            currentTime: Date.now()
        })
    }

}

const enum StorageCategory {
    CONTENTS = "contents",
    PROOFS = "proofs",
    POINTERS = "pointers",
}
