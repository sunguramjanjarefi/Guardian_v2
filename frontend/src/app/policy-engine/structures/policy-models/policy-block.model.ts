import { moveItemInArray } from '@angular/cdk/drag-drop';
import { GenerateUUIDv4, IArtifact } from '@guardian/interfaces';
import { BlockType } from './../types/block-type.type';
import { PolicyEventModel } from './policy-event.model';
import { PolicyModel } from './policy.model';
import { IBlockConfig } from './block-config.interface';
import { IEventConfig } from './event-config.interface';

export class PolicyBlockModel {
    private readonly policy: PolicyModel;

    public readonly id: string;
    public readonly blockType: string;

    private _parent: PolicyBlockModel | null;
    private _children: PolicyBlockModel[];
    private _events: PolicyEventModel[];
    private _artifacts!: IArtifact[];
    private _root: boolean;

    public readonly properties: { [name: string]: any; };

    private _changed: boolean;

    constructor(config: IBlockConfig, parent: PolicyBlockModel | null, policy: PolicyModel) {
        this._changed = false;
        this._root = false;

        this.policy = policy;

        this.id = config.id || GenerateUUIDv4();
        this.blockType = config.blockType;

        config.tag = config.tag || "";
        if (!Array.isArray(config.permissions)) {
            config.permissions = [];
        }

        this._parent = parent;

        const clone: any = { ...config };
        delete clone.children;
        delete clone.events;

        this.properties = clone;

        this._children = [];
        if (Array.isArray(config.children)) {
            for (const child of config.children) {
                this._children.push(
                    new PolicyBlockModel(child, this, this.policy)
                );
            }
        }

        this._events = [];
        if (Array.isArray(config.events)) {
            for (const event of config.events) {
                this._events.push(
                    new PolicyEventModel(event, this)
                );
            }
        }

        this._artifacts = config.artifacts || [];
    }

    public get isModule(): boolean {
        return false;
    }

    public get root(): boolean {
        return this._root;
    }

    public get expandable(): boolean {
        return !!(this.children && this.children.length);
    }

    public get tag(): string {
        return this.properties.tag;
    }

    public set tag(value: string) {
        this.properties.tag = value;
        this.changed = true;
    }

    public get permissions(): string[] {
        return this.properties.permissions;
    }

    public set permissions(value: string[]) {
        this.silentlySetPermissions(value);
        this.changed = true;
    }

    public set root(value: boolean) {
        this._root = value;
    }

    public silentlySetPermissions(value: string[]) {
        if (Array.isArray(value)) {
            this.properties.permissions = value;
        } else {
            this.properties.permissions = [];
        }
    }

    public get children(): PolicyBlockModel[] {
        return this._children;
    }

    public get events(): PolicyEventModel[] {
        return this._events;
    }

    public get artifacts(): IArtifact[] {
        return this._artifacts;
    }

    public get parent(): PolicyBlockModel | null {
        return this._parent;
    }

    public set parent(value: PolicyBlockModel | null) {
        this._parent = value;
        this.changed = true;
    }

    public get parent2(): PolicyBlockModel | null {
        if (this._parent && !this._parent.isModule) {
            return this._parent._parent;
        }
        return null;
    }

    public get changed(): boolean {
        return this._changed;
    }

    public set changed(value: boolean) {
        this._changed = value;
        if (this.policy) {
            this.policy.changed = true;
        }
    }

    public get next(): PolicyBlockModel | undefined {
        if (this.parent) {
            const index = this.parent.children.findIndex(c => c.id == this.id);
            let next = this.parent.children[index + 1];
            return next;
        }
        return undefined;
    }

    public get prev(): PolicyBlockModel | undefined {
        if (this.parent) {
            const index = this.parent.children.findIndex(c => c.id == this.id);
            return this.parent.children[index - 1];
        }
        return undefined;
    }

    public get lastChild(): PolicyBlockModel | null {
        try {
            return this._children[this._children.length - 1];
        } catch (error) {
            return null;
        }
    }

    public remove() {
        if (this.parent) {
            this.parent._removeChild(this);
        }
        this._parent = null;

        this.policy.refresh();
    }

    public removeChild(child: PolicyBlockModel) {
        this._removeChild(child);
        child._parent = null;

        this.policy.refresh();
    }

    public createChild(block: IBlockConfig, index?: number) {
        delete block.children;
        const child = new PolicyBlockModel(block, this, this.policy);
        if (!child.permissions || !child.permissions.length) {
            child.permissions = this.permissions.slice();
        }
        this._addChild(child, index);
        this.policy.refresh();
    }

    public copyChild(block: IBlockConfig) {
        this._copyChild(block);
        this.policy.refresh();
    }

    public addChild(child: PolicyBlockModel, index?: number) {
        this._addChild(child, index);

        this.policy.refresh();
    }

    public refresh() {
        this.policy.refresh();
    }

    private _copyChild(block: IBlockConfig) {
        block.id = GenerateUUIDv4();
        const children = block.children;
        delete block.children;
        delete block.events;

        const newBlock = new PolicyBlockModel(block, this, this.policy);
        newBlock.tag = this.policy.getNewTag('Block', newBlock);
        this._addChild(newBlock);

        if (Array.isArray(children)) {
            for (const child of children) {
                newBlock._copyChild(child);
            }
        }
    }

    private _addChild(child: PolicyBlockModel, index?: number) {
        child._parent = this;
        if (index !== undefined && Number.isFinite(index)) {
            if (index < 0) {
                this._children.unshift(child);
            } else if (index >= this._children.length) {
                this._children.push(child);
            } else {
                this._children.splice(index, 0, child);
            }
        } else {
            this._children.push(child);
        }
    }

    private _removeChild(child: PolicyBlockModel) {
        const index = this._children.findIndex((c) => c.id == child.id);
        if (index !== -1) {
            this._children.splice(index, 1);
        }
    }

    public createEvent(event: IEventConfig) {
        const e = new PolicyEventModel(event, this);
        this._addEvent(e);

        this.policy.refresh();
    }

    public addEvent(event: PolicyEventModel) {
        this._addEvent(event);

        this.policy.refresh();
    }

    private _addEvent(event: PolicyEventModel) {
        this._events.push(event);
    }

    public removeEvent(event: PolicyEventModel) {
        const index = this._events.findIndex((c) => c.id == event.id);
        if (index !== -1) {
            this._events.splice(index, 1);
            this.policy.refresh();
        }
    }

    public addArtifact(artifact: IArtifact) {
        this._artifacts.push(artifact);
        this._changed = true;
    }

    public removeArtifact(artifact: IArtifact) {
        const index = this._artifacts.indexOf(artifact);
        if (index !== -1) {
            this._artifacts.splice(index, 1);
            this._changed = true;
        }
    }

    public changeArtifactPosition(prevIndex: number, currentIndex: number) {
        moveItemInArray(this._artifacts, prevIndex, currentIndex);
        this._changed = true;
    }

    public emitUpdate() {
        this._changed = false;
        this.policy.emitUpdate();
    }

    public getJSON(): any {
        const json: any = { ...this.properties };
        json.id = this.id;
        json.blockType = this.blockType;
        json.tag = this.tag;
        json.children = [];
        json.events = [];
        json.artifacts = this.artifacts || [];

        for (const block of this.children) {
            json.children.push(block.getJSON());
        }
        for (const event of this.policy.allEvents) {
            if (event.isSource(this)) {
                json.events.push(event.getJSON());
            }
        }

        return json;
    }

    public rebuild(object: any) {
        delete object.children;
        delete object.events;

        const keys1 = Object.keys(this.properties);
        const keys2 = Object.keys(object);
        for (const key of keys1) {
            if (key !== 'blockType' &&
                key !== 'id' &&
                key !== 'tag') {
                delete this.properties[key];
            }
        }
        for (const key of keys2) {
            this.properties[key] = object[key];
        }

        this.policy.emitUpdate();
    }

    public checkChange() {
        if (this._changed) {
            this.emitUpdate();
        }
    }

    public isFinal(): boolean {
        if (this.parent && this.parent.blockType === BlockType.Step) {
            if (this.parent.lastChild == this) {
                return true;
            }
            if (Array.isArray(this.parent.properties?.finalBlocks)) {
                return this.parent.properties.finalBlocks.indexOf(this.tag) > -1;
            }
        }
        return false;
    }

    public append(parent: PolicyBlockModel) {
        parent.addChild(this);
    }

    public replace(oldItem: PolicyBlockModel, newItem: PolicyBlockModel) {
        oldItem.parent = null;
        newItem.parent = this;
        const index = this._children.findIndex((c) => c.id == oldItem.id);
        if (index !== -1) {
            this._children[index] = newItem;
        } else {
            this._children.push(newItem);
        }
        this.policy.refresh();
    }

    public index(): number {
        if (this.parent) {
            return this.parent.indexOf(this);
        }
        return -1;
    }

    public indexOf(block: PolicyBlockModel): number {
        return this._children.indexOf(block);
    }

    public appendTo(parent: PolicyBlockModel | null, index?: number): boolean {
        if (parent) {
            if (this._parent) {
                this._parent._removeChild(this);
                this._parent = null;
            }
            parent.addChild(this, index);
            this.policy.refresh();
            return true;
        }
        return false;
    }
}