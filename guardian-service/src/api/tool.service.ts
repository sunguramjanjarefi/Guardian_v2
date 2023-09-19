import { ApiResponse } from '@api/helpers/api-response';
import {
    BinaryMessageResponse,
    DatabaseServer,
    Logger,
    MessageAction,
    MessageError,
    MessageResponse,
    MessageServer,
    MessageType,
    ToolMessage,
    PolicyTool,
    TagMessage,
    TopicConfig,
    TopicHelper,
    Users,
    ToolImportExport,
    RunFunctionAsync
} from '@guardian/common';
import {
    GenerateUUIDv4,
    MessageAPI,
    ModuleStatus,
    SchemaCategory,
    TagType,
    TopicType
} from '@guardian/interfaces';
import { emptyNotifier, initNotifier, INotifier } from '@helpers/notifier';
import { ISerializedErrors } from '@policy-engine/policy-validation-results-container';
import { ToolValidator } from '@policy-engine/block-validators/tool-validator';
import { importTag } from './tag.service';
import { PolicyConverterUtils } from '@policy-engine/policy-converter-utils';

/**
 * Check and update config file
 * @param tool
 *
 * @returns tool
 */
export function updateToolConfig(tool: any): any {
    tool.config = tool.config || {};
    tool.config.permissions = tool.config.permissions || [];
    tool.config.children = tool.config.children || [];
    tool.config.events = tool.config.events || [];
    tool.config.artifacts = tool.config.artifacts || [];
    tool.config.variables = tool.config.variables || [];
    tool.config.inputEvents = tool.config.inputEvents || [];
    tool.config.outputEvents = tool.config.outputEvents || [];
    tool.config.innerEvents = tool.config.innerEvents || [];
    return tool;
}

/**
 * Prepare tool for preview by message
 * @param messageId
 * @param owner
 * @param notifier
 */
export async function preparePreviewMessage(messageId: string, owner: string, notifier: INotifier): Promise<any> {
    notifier.start('Resolve Hedera account');
    if (!messageId) {
        throw new Error('Message ID in body is empty');
    }

    const users = new Users();
    const root = await users.getHederaAccount(owner);
    const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
    const message = await messageServer.getMessage<ToolMessage>(messageId);
    if (message.type !== MessageType.Tool) {
        throw new Error('Invalid Message Type');
    }

    if (!message.document) {
        throw new Error('file in body is empty');
    }

    notifier.completedAndStart('Parse tool files');
    const result: any = await ToolImportExport.parseZipFile(message.document);
    result.messageId = messageId;
    result.toolTopicId = message.toolTopicId;

    notifier.completed();
    return result;
}

/**
 * Validate and publish tool
 * @param id
 * @param owner
 * @param notifier
 */
export async function validateAndPublish(id: string, owner: string, notifier: INotifier) {
    notifier.start('Find and validate tool');
    const item = await DatabaseServer.getToolById(id);
    if (!item) {
        throw new Error('Unknown tool');
    }
    if (!item.config) {
        throw new Error('The tool is empty');
    }
    if (item.status === ModuleStatus.PUBLISHED) {
        throw new Error(`Tool already published`);
    }

    const errors = await validateTool(item);
    const isValid = !errors.blocks.some(block => !block.isValid);
    notifier.completed();

    if (isValid) {
        const newTool = await publishTool(item, owner, notifier);
        return { tool: newTool, isValid, errors };
    } else {
        return { tool: item, isValid, errors };
    }
}

/**
 * Validate tool
 * @param tool
 */
export async function validateTool(tool: PolicyTool): Promise<ISerializedErrors> {
    const toolValidator = new ToolValidator(tool.config);
    await toolValidator.validate();
    return toolValidator.getSerializedErrors();
}

/**
 * Publish tool
 * @param tool
 * @param owner
 * @param version
 * @param notifier
 */
export async function publishTool(
    tool: PolicyTool,
    owner: string,
    notifier: INotifier
): Promise<PolicyTool> {
    const logger = new Logger();
    logger.info('Publish tool', ['GUARDIAN_SERVICE']);

    notifier.start('Generate file');
    tool = updateToolConfig(tool);
    const zip = await ToolImportExport.generate(tool);
    const buffer = await zip.generateAsync({
        type: 'arraybuffer',
        compression: 'DEFLATE',
        compressionOptions: {
            level: 3
        }
    });

    notifier.completedAndStart('Resolve Hedera account');
    const users = new Users();
    const root = await users.getHederaAccount(owner);

    notifier.completedAndStart('Find topic');
    const topic = await TopicConfig.fromObject(await DatabaseServer.getTopicById(tool.topicId), true);
    const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey)
        .setTopicObject(topic);

    notifier.completedAndStart('Publish tool');
    const message = new ToolMessage(MessageType.Tool, MessageAction.PublishTool);
    message.setDocument(tool, buffer);
    const result = await messageServer
        .sendMessage(message);

    notifier.completedAndStart('Saving in DB');
    tool.messageId = result.getId();
    tool.status = ModuleStatus.PUBLISHED;
    const retVal = await DatabaseServer.updateTool(tool);

    notifier.completed();

    logger.info('Published tool', ['GUARDIAN_SERVICE']);

    return retVal
}

/**
 * Create tool
 * @param tool
 * @param owner
 * @param version
 * @param notifier
 */
export async function createTool(
    json: any,
    owner: string,
    notifier: INotifier
): Promise<PolicyTool> {
    const logger = new Logger();
    logger.info('Create Policy', ['GUARDIAN_SERVICE']);
    notifier.start('Save in DB');
    if (json) {
        delete json._id;
        delete json.id;
        delete json.status;
        delete json.owner;
        delete json.version;
        delete json.messageId;
    }
    json.creator = owner;
    json.owner = owner;
    json.type = 'CUSTOM';
    json.status = ModuleStatus.DRAFT;
    json.codeVersion = PolicyConverterUtils.VERSION;
    updateToolConfig(json);
    const tool = await DatabaseServer.createTool(json);

    try {
        if (!tool.topicId) {
            notifier.completedAndStart('Resolve Hedera account');
            const users = new Users();
            const root = await users.getHederaAccount(owner);

            notifier.completedAndStart('Create topic');
            logger.info('Create Tool: Create New Topic', ['GUARDIAN_SERVICE']);
            const parent = await TopicConfig.fromObject(
                await DatabaseServer.getTopicByType(owner, TopicType.UserTopic), true
            );
            const topicHelper = new TopicHelper(root.hederaAccountId, root.hederaAccountKey);
            const topic = await topicHelper.create({
                type: TopicType.ToolTopic,
                name: tool.name || TopicType.ToolTopic,
                description: tool.description || TopicType.ToolTopic,
                owner,
                targetId: tool.id.toString(),
                targetUUID: tool.uuid
            });
            await topic.saveKeys();

            notifier.completedAndStart('Create tool in Hedera');
            const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
            const message = new ToolMessage(MessageType.Tool, MessageAction.CreateTool);
            message.setDocument(tool);
            const messageStatus = await messageServer
                .setTopicObject(parent)
                .sendMessage(message);

            notifier.completedAndStart('Link topic and tool');
            await topicHelper.twoWayLink(topic, parent, messageStatus.getId());

            await DatabaseServer.saveTopic(topic.toObject());
            tool.topicId = topic.topicId;
            await DatabaseServer.updateTool(tool);
            notifier.completed();
        }

        return tool;
    } catch (error) {
        await DatabaseServer.removeTool(tool);
        throw error;
    }
}

/**
 * Connect to the message broker methods of working with tools.
 */
export async function toolsAPI(): Promise<void> {
    /**
     * Create new tool
     *
     * @param payload - tool
     *
     * @returns {PolicyTool} new tool
     */
    ApiResponse(MessageAPI.CREATE_TOOL, async (msg) => {
        try {
            if (!msg) {
                throw new Error('Invalid Params');
            }
            const { tool, owner } = msg;
            const item = await createTool(tool, owner, emptyNotifier());
            return new MessageResponse(item);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    /**
     * Create new tool
     *
     * @param payload - tool
     *
     * @returns {PolicyTool} new tool
     */
    ApiResponse(MessageAPI.CREATE_TOOL_ASYNC, async (msg) => {
        if (!msg) {
            throw new Error('Invalid Params');
        }
        const { tool, owner, task } = msg;
        const notifier = await initNotifier(task);
        RunFunctionAsync(async () => {
            const item = await createTool(tool, owner, notifier);
            notifier.result(item.id);
        }, async (error) => {
            notifier.error(error);
        });
        return new MessageResponse(task);
    });

    ApiResponse(MessageAPI.GET_TOOLS, async (msg) => {
        try {
            if (!msg) {
                return new MessageError('Invalid load tools parameter');
            }

            const { pageIndex, pageSize, owner } = msg;
            const filter: any = {}
            if (owner) {
                filter.owner = owner;
            }

            const otherOptions: any = {};
            const _pageSize = parseInt(pageSize, 10);
            const _pageIndex = parseInt(pageIndex, 10);
            if (Number.isInteger(_pageSize) && Number.isInteger(_pageIndex)) {
                otherOptions.orderBy = { createDate: 'DESC' };
                otherOptions.limit = _pageSize;
                otherOptions.offset = _pageIndex * _pageSize;
            } else {
                otherOptions.orderBy = { createDate: 'DESC' };
                otherOptions.limit = 100;
            }

            const [items, count] = await DatabaseServer.getToolsAndCount(filter, otherOptions);

            return new MessageResponse({ items, count });
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.DELETE_TOOL, async (msg) => {
        try {
            if (!msg.id || !msg.owner) {
                return new MessageError('Invalid load tools parameter');
            }
            const item = await DatabaseServer.getToolById(msg.id);
            if (!item || item.owner !== msg.owner) {
                throw new Error('Invalid tool');
            }
            await DatabaseServer.removeTool(item);
            return new MessageResponse(true);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.GET_MENU_TOOLS, async (msg) => {
        try {
            if (!msg.owner) {
                return new MessageError('Invalid load tools parameter');
            }
            const items = await DatabaseServer.getTools({
                owner: msg.owner
            });
            // for (const item of items) {
            //     if (item.config?.variables) {
            //         for (const variable of item.config.variables) {
            //             if (variable.baseSchema) {
            //                 variable.baseSchema = await DatabaseServer.getSchema({ iri: variable.baseSchema });
            //             }
            //         }
            //     }
            // }
            return new MessageResponse(items);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.UPDATE_TOOL, async (msg) => {
        try {
            if (!msg) {
                return new MessageError('Invalid load tools parameter');
            }
            const { id, tool, owner } = msg;
            const item = await DatabaseServer.getToolById(id);
            if (!item || item.owner !== owner) {
                throw new Error('Invalid tool');
            }
            if (item.status === ModuleStatus.PUBLISHED) {
                throw new Error('Tool published');
            }

            item.config = tool.config;
            item.name = tool.name;
            item.description = tool.description;
            updateToolConfig(item);

            const result = await DatabaseServer.updateTool(item);
            return new MessageResponse(result);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.GET_TOOL, async (msg) => {
        try {
            if (!msg.id || !msg.owner) {
                return new MessageError('Invalid load tools parameter');
            }
            const item = await DatabaseServer.getToolById(msg.id);
            if (!item || item.owner !== msg.owner) {
                throw new Error('Invalid tool');
            }
            return new MessageResponse(item);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_EXPORT_FILE, async (msg) => {
        try {
            if (!msg.id || !msg.owner) {
                return new MessageError('Invalid load tools parameter');
            }

            const item = await DatabaseServer.getToolById(msg.id);
            if (!item || item.owner !== msg.owner) {
                throw new Error('Invalid tool');
            }

            updateToolConfig(item);
            const zip = await ToolImportExport.generate(item);
            const file = await zip.generateAsync({
                type: 'arraybuffer',
                compression: 'DEFLATE',
                compressionOptions: {
                    level: 3,
                },
            });
            return new BinaryMessageResponse(file);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_EXPORT_MESSAGE, async (msg) => {
        try {
            if (!msg.id || !msg.owner) {
                return new MessageError('Invalid load tools parameter');
            }

            const item = await DatabaseServer.getToolById(msg.id);
            if (!item || item.owner !== msg.owner) {
                throw new Error('Invalid tool');
            }

            return new MessageResponse({
                id: item.id,
                uuid: item.uuid,
                name: item.name,
                description: item.description,
                messageId: item.messageId,
                owner: item.owner
            });
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_IMPORT_FILE_PREVIEW, async (msg) => {
        try {
            const { zip } = msg;
            if (!zip) {
                throw new Error('file in body is empty');
            }
            const preview = await ToolImportExport.parseZipFile(Buffer.from(zip.data));
            return new MessageResponse(preview);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_IMPORT_MESSAGE_PREVIEW, async (msg) => {
        try {
            const { messageId, owner } = msg;
            const preview = await preparePreviewMessage(messageId, owner, emptyNotifier());
            return new MessageResponse(preview);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_IMPORT_FILE, async (msg) => {
        try {
            const { zip, owner } = msg;
            if (!zip) {
                throw new Error('file in body is empty');
            }

            const preview = await ToolImportExport.parseZipFile(Buffer.from(zip.data));

            const { tool, tags, schemas } = preview;
            delete tool._id;
            delete tool.id;
            delete tool.messageId;
            delete tool.createDate;
            tool.uuid = GenerateUUIDv4();
            tool.creator = owner;
            tool.owner = owner;
            tool.status = ModuleStatus.DRAFT;
            if (await DatabaseServer.getTool({ name: tool.name })) {
                tool.name = tool.name + '_' + Date.now();
            }
            const item = await DatabaseServer.createTool(tool);

            if (Array.isArray(tags)) {
                const toolTags = tags.filter((t: any) => t.entity === TagType.Tool);
                await importTag(toolTags, item.id.toString());
            }

            if (Array.isArray(schemas)) {
                for (const schema of schemas) {
                    const schemaObject = DatabaseServer.createSchema(schema);
                    schemaObject.category = SchemaCategory.TOOL;
                    await DatabaseServer.saveSchema(schemaObject);
                }
            }

            return new MessageResponse(item);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.TOOL_IMPORT_MESSAGE, async (msg) => {
        try {
            const { messageId, owner } = msg;
            if (!messageId) {
                throw new Error('Message ID in body is empty');
            }

            const notifier = emptyNotifier();
            const preview = await preparePreviewMessage(messageId, owner, notifier);

            const { tool, tags, toolTopicId } = preview;
            delete tool._id;
            delete tool.id;
            delete tool.messageId;
            delete tool.createDate;
            tool.uuid = GenerateUUIDv4();
            tool.creator = owner;
            tool.owner = owner;
            tool.status = 'DRAFT';
            tool.type = 'CUSTOM';
            if (await DatabaseServer.getTool({ name: tool.name })) {
                tool.name = tool.name + '_' + Date.now();
            }
            const item = await DatabaseServer.createTool(tool);

            if (toolTopicId) {
                const messageServer = new MessageServer(null, null);
                const tagMessages = await messageServer.getMessages<TagMessage>(
                    toolTopicId,
                    MessageType.Tag,
                    MessageAction.PublishTag
                );
                for (const tag of tagMessages) {
                    if (tag.entity === TagType.Tool && tag.target === messageId) {
                        tags.push({
                            uuid: tag.uuid,
                            name: tag.name,
                            description: tag.description,
                            owner: tag.owner,
                            entity: tag.entity,
                            target: tag.target,
                            status: 'History',
                            topicId: tag.topicId,
                            messageId: tag.id,
                            date: tag.date,
                            document: null,
                            uri: null,
                            id: null
                        });
                    }
                }
            }
            if (tags.length) {
                const toolTags = tags.filter((t: any) => t.entity === TagType.Tool);
                await importTag(toolTags, item.id.toString());
            }
            return new MessageResponse(item);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.PUBLISH_TOOL, async (msg) => {
        try {
            const { id, owner } = msg;
            const result = await validateAndPublish(id, owner, emptyNotifier());
            return new MessageResponse(result);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.PUBLISH_TOOL_ASYNC, async (msg) => {
        try {
            const { id, owner, task } = msg;
            const notifier = await initNotifier(task);

            RunFunctionAsync(async () => {
                const result = await validateAndPublish(id, owner, notifier);
                notifier.result(result);
            }, async (error) => {
                new Logger().error(error, ['GUARDIAN_SERVICE']);
                notifier.error(error);
            });

            return new MessageResponse(task);
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });

    ApiResponse(MessageAPI.VALIDATE_TOOL, async (msg) => {
        try {
            const { tool } = msg;
            const results = await validateTool(tool);
            return new MessageResponse({
                results,
                tool
            });
        } catch (error) {
            new Logger().error(error, ['GUARDIAN_SERVICE']);
            return new MessageError(error);
        }
    });
}
