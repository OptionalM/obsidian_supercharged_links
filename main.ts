import {Plugin, MarkdownView, Notice, App, editorViewField, debounce} from 'obsidian';
import SuperchargedLinksSettingTab from "src/settings/SuperchargedLinksSettingTab"
import {
	updateElLinks,
	updateVisibleLinks,
	clearExtraAttributes,
	updateDivExtraAttributes,
	fetchTargetAttributesSync
} from "src/linkAttributes/linkAttributes"
import { SuperchargedLinksSettings, DEFAULT_SETTINGS } from "src/settings/SuperchargedLinksSettings"
import Field from 'src/Field';
import linkContextMenu from "src/options/linkContextMenu"
import NoteFieldsCommandsModal from "src/options/NoteFieldsCommandsModal"
import FileClassAttributeSelectModal from 'src/fileClass/FileClassAttributeSelectModal';
import { CSSBuilderModal } from 'src/cssBuilder/cssBuilderModal'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/rangeset";
import { syntaxTree } from "@codemirror/language";
import { tokenClassNodeProp } from "@codemirror/stream-parser";
import { Prec } from "@codemirror/state";

export default class SuperchargedLinks extends Plugin {
	settings: SuperchargedLinksSettings;
	initialProperties: Array<Field> = []
	settingTab: SuperchargedLinksSettingTab
	private observers: [MutationObserver, string, string][];

	async onload(): Promise<void> {
		console.log('Supercharged links loaded');
		await this.loadSettings();


		this.settings.presetFields.forEach(prop => {
			const property = new Field()
			Object.assign(property, prop)
			this.initialProperties.push(property)
		})
		this.addSettingTab(new SuperchargedLinksSettingTab(this.app, this));
		this.registerMarkdownPostProcessor((el, ctx) => {
			updateElLinks(this.app, this.settings, el, ctx)
		});

		this.registerEvent(this.app.metadataCache.on('changed', debounce((_file) => {
			updateVisibleLinks(this.app, this.settings);
			this.observers.forEach(([observer, type, own_class ]) => {
				const leaves = this.app.workspace.getLeavesOfType(type);
				leaves.forEach(leaf => {
					this.updateContainer(leaf.view.containerEl, this, own_class);
				})
			});
			// Debounced to prevent lag when writing
		}, 4500, true)));


		const ext = Prec.lowest(this.buildCMViewPlugin(this.app, this.settings));
		this.registerEditorExtension(ext);

		this.observers = [];

		this.app.workspace.onLayoutReady(() => this.initViewObservers(this));
		this.app.workspace.on("layout-change", () => this.initViewObservers(this));

		this.addCommand({
			id: "field_options",
			name: "field options",
			hotkeys: [
				{
					modifiers: ["Alt"],
					key: 'O',
				},
			],
			callback: () => {
				const leaf = this.app.workspace.activeLeaf
				if (leaf.view instanceof MarkdownView && leaf.view.file) {
					const fieldsOptionsModal = new NoteFieldsCommandsModal(this.app, this, leaf.view.file)
					fieldsOptionsModal.open()
				}
			},
		});

		/* TODO : add a context menu for fileClass files to show the same options as in FileClassAttributeSelectModal*/
		this.addCommand({
			id: "fileClassAttr_options",
			name: "fileClass attributes options",
			hotkeys: [
				{
					modifiers: ["Alt"],
					key: 'P',
				},
			],
			callback: () => {
				const leaf = this.app.workspace.activeLeaf
				if (leaf.view instanceof MarkdownView && leaf.view.file && `${leaf.view.file.parent.path}/` == this.settings.classFilesPath) {
					const modal = new FileClassAttributeSelectModal(this, leaf.view.file)
					modal.open()
				} else {
					const notice = new Notice("This is not a fileClass", 2500)
				}
			},
		});

		this.addCommand({
			id: "css_snippet_helper",
			name: "CSS Snippet helper",
			callback: () => {
				const formModal = new CSSBuilderModal(this)
				formModal.open()
			},
		});

		new linkContextMenu(this)
	}

	initViewObservers(plugin: SuperchargedLinks) {
		plugin.observers.forEach(([observer, type ]) => {
			observer.disconnect();
		});
		plugin.registerViewType('backlink', plugin, ".tree-item-inner", true);
		plugin.registerViewType('outgoing-link', plugin, ".tree-item-inner", true);
		plugin.registerViewType('search', plugin, ".tree-item-inner");
		plugin.registerViewType('BC-matrix', plugin, '.BC-Link');
		plugin.registerViewType('BC-ducks', plugin, '.internal-link');
		plugin.registerViewType('BC-tree', plugin, 'a.internal-link');
		plugin.registerViewType('graph-analysis', plugin, '.internal-link');
		plugin.registerViewType('starred', plugin, '.nav-file-title-content');
		plugin.registerViewType('file-explorer', plugin, '.nav-file-title-content' );
		plugin.registerViewType('recent-files', plugin, '.nav-file-title-content' );
	}

	registerViewType(viewTypeName: string, plugin: SuperchargedLinks, selector: string, updateDynamic = false ){
		const leaves = this.app.workspace.getLeavesOfType(viewTypeName);
		if (leaves.length > 1) console.error('more than one ' + viewTypeName + ' panel');
		else if (leaves.length < 1) return;
		else {
			const container = leaves[0].view.containerEl;
			this.updateContainer(container, plugin, selector);
			if (updateDynamic) {
				plugin._watchContainerDynamic(viewTypeName, container, plugin, selector)
			}
			else {
				plugin._watchContainer(viewTypeName, container, plugin, selector);
			}
		}
	}

	updateContainer(container: HTMLElement, plugin: SuperchargedLinks, selector: string) {
		if (!plugin.settings.enableBacklinks) return;
		const nodes = container.findAll(selector);
		for (let i = 0; i < nodes.length; ++i)  {
			const el = nodes[i] as HTMLElement;
			updateDivExtraAttributes(plugin.app, plugin.settings, el, "");
		}
	}

	removeFromContainer(container: HTMLElement, selector: string) {
		const nodes = container.findAll(selector);
		for (let i = 0; i < nodes.length; ++i)  {
		    const el = nodes[i] as HTMLElement;
			clearExtraAttributes(el);
		}
	}

	_watchContainer(viewType: string, container: HTMLElement, plugin: SuperchargedLinks, selector: string) {
		let observer = new MutationObserver((records, _) => {
			 plugin.updateContainer(container, plugin, selector);
		});
		observer.observe(container, { subtree: true, childList: true, attributes: false });
		plugin.observers.push([observer, viewType, selector]);
	}

	_watchContainerDynamic(viewType: string, container: HTMLElement, plugin: SuperchargedLinks, selector: string, own_class='tree-item-inner', parent_class='tree-item') {
		// Used for efficient updating of the backlinks panel
		// Only loops through newly added DOM nodes instead of changing all of them
		let observer = new MutationObserver((records, _) => {
			records.forEach((mutation) => {
				if (mutation.type === 'childList') {
					mutation.addedNodes.forEach((n) => {
						if ('className' in n) {
							// @ts-ignore
							if (n.className.includes && typeof n.className.includes === 'function' && n.className.includes(parent_class)) {
								const fileDivs = (n as HTMLElement).getElementsByClassName(own_class);
								for (let i = 0; i < fileDivs.length; ++i) {
									const link = fileDivs[i] as HTMLElement;
									updateDivExtraAttributes(plugin.app, plugin.settings, link, "");
								}
							}
						}
					});
				}
			});
		});
		observer.observe(container, { subtree: true, childList: true, attributes: false });
		plugin.observers.push([observer, viewType, selector]);
	}

	buildCMViewPlugin(app: App, _settings: SuperchargedLinksSettings) {
		// Implements the live preview supercharging
		// Code structure based on https://github.com/nothingislost/obsidian-cm6-attributes/blob/743d71b0aa616407149a0b6ea5ffea28e2154158/src/main.ts
		// Code help credits to @NothingIsLost! They have been a great help getting this to work properly.
		class HeaderWidget extends WidgetType {
			attributes: Record<string, string>

			constructor(attributes: Record<string, string>) {
				super();
				this.attributes = attributes
			}

			toDOM() {
				let headerEl = document.createElement("span");
				headerEl.setAttrs(this.attributes);
				headerEl.addClass('data-link-icon');
				// create a naive bread crumb
				return headerEl;
			}

			ignoreEvent() {
				return true;
			}
		}
		const settings = _settings;
		const viewPlugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.decorations = this.buildDecorations(view);
				}

				update(update: ViewUpdate) {
					if (update.docChanged || update.viewportChanged) {
						this.decorations = this.buildDecorations(update.view);
					}
				}

				destroy() { }

				buildDecorations(view: EditorView) {
					let builder = new RangeSetBuilder<Decoration>();
					if (!settings.enableEditor) {
						return builder.finish();
					}
					const mdView = view.state.field(editorViewField) as MarkdownView;
					let lastAttributes = {};
					for (let { from, to } of view.visibleRanges) {
						syntaxTree(view.state).iterate({
							from,
							to,
							enter: (type, from, to) => {
								const tokenProps = type.prop(tokenClassNodeProp);
								if (tokenProps) {
									const props = new Set(tokenProps.split(" "));
									const isLink = props.has("hmd-internal-link");
									const isAlias = props.has("link-alias");
									const isPipe = props.has("link-alias-pipe");
									// if (props.has("hmd-internal-link")) {console.log("props", type, from, to)}
									if (isLink && !isAlias && !isPipe) {
										let linkText = view.state.doc.sliceString(from, to);
										linkText = linkText.split("#")[0];
										let file = app.metadataCache.getFirstLinkpathDest(linkText, mdView.file.basename);
										if (file) {
											let _attributes = fetchTargetAttributesSync(app, settings, file, true);
											let attributes: Record<string, string> = {};
											for (let key in _attributes) {
												attributes["data-link-" + key] = _attributes[key];
											}
											let deco = Decoration.mark({
												attributes
											});
											let iconDeco = Decoration.widget({
												widget: new HeaderWidget(attributes),
											});
											builder.add(from, from, iconDeco);
											builder.add(from, to, deco);
											lastAttributes = attributes;
										}
									}
									else if (isLink && isAlias) {
										let deco = Decoration.mark({
											attributes: lastAttributes
										})
										builder.add(from, to, deco);
									}
								}
							}
						})

					}
					return builder.finish();
				}
			},
			{
				decorations: v => v.decorations
			}
		);
		return viewPlugin;
	}

	onunload() {
		this.observers.forEach(([observer, type, own_class ]) => {
			observer.disconnect();
			const leaves = this.app.workspace.getLeavesOfType(type);
			leaves.forEach(leaf => {
				this.removeFromContainer(leaf.view.containerEl, own_class);
			})
		});
		console.log('Supercharged links unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		this.settings.presetFields = this.initialProperties
		await this.saveData(this.settings);
	}
}