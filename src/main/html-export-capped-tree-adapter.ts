import {
  defaultTreeAdapter,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type Token,
  type TreeAdapter,
  type html,
} from 'parse5';

export const HTML_EXPORT_PARSE_LIMITS = {
  maxNodes: 20_000,
  maxDepth: 64,
  maxAttributesPerElement: 256,
  maxAttributes: 8_192,
} as const;

export type HtmlExportParseCounts = {
  nodeCount: number;
  maxDepth: number;
  attributeCount: number;
};

export class HtmlExportParseLimitError extends Error {
  readonly code: 'pipeline-oversize' = 'pipeline-oversize';

  constructor(detail: string) {
    super(detail);
    this.name = 'HtmlExportParseLimitError';
  }
}

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;
type Document = DefaultTreeAdapterTypes.Document;
type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Attribute = Token.Attribute;
export function countReachableHtmlExportDocument(document: Document): HtmlExportParseCounts {
  let nodeCount = 0;
  let maxDepth = 0;
  let attributeCount = 0;
  const seen = new Set<Node>();
  const pending: Array<{ node: Node; depth: number }> = [{ node: document, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.node)) throw new Error('Parsed document contains a node cycle');
    seen.add(current.node);

    nodeCount++;
    maxDepth = Math.max(maxDepth, current.depth);
    if (nodeCount > HTML_EXPORT_PARSE_LIMITS.maxNodes) {
      throw new HtmlExportParseLimitError(`node count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxNodes}`);
    }
    if (current.depth > HTML_EXPORT_PARSE_LIMITS.maxDepth) {
      throw new HtmlExportParseLimitError(`tree depth exceeds ${HTML_EXPORT_PARSE_LIMITS.maxDepth}`);
    }

    if (defaultTreeAdapter.isElementNode(current.node)) {
      if (current.node.attrs.length > HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement) {
        throw new HtmlExportParseLimitError(
          `element attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement}`,
        );
      }
      attributeCount += current.node.attrs.length;
      if (attributeCount > HTML_EXPORT_PARSE_LIMITS.maxAttributes) {
        throw new HtmlExportParseLimitError(`attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributes}`);
      }
    }

    if ('childNodes' in current.node) {
      for (const child of current.node.childNodes) {
        pending.push({ node: child, depth: current.depth + 1 });
      }
    }
    if (current.node.nodeName === 'template') {
      pending.push({ node: (current.node as Template).content, depth: current.depth + 1 });
    }
  }

  return { nodeCount, maxDepth, attributeCount };
}

/**
 * parse5's default tree adapter with construction-time resource caps.  It keeps
 * parse5's default node representation and mutation semantics for accepted
 * documents, while rejecting before an oversized tree can be returned.
 */
export class CappedTreeAdapter implements TreeAdapter<DefaultTreeAdapterMap> {
  private nodeCount = 0;
  private attributeCount = 0;
  private maxDepth = 0;
  private readonly templateOwners = new WeakMap<DocumentFragment, Template>();

  /** Construction-time high-water data; detached parse5 nodes remain budgeted. */
  get counts(): HtmlExportParseCounts {
    return {
      nodeCount: this.nodeCount,
      maxDepth: this.maxDepth,
      attributeCount: this.attributeCount,
    };
  }

  private reserveNode(): void {
    if (this.nodeCount >= HTML_EXPORT_PARSE_LIMITS.maxNodes) {
      throw new HtmlExportParseLimitError(`node count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxNodes}`);
    }
    this.nodeCount++;
  }

  private reserveAttributes(attrs: Attribute[]): void {
    if (attrs.length > HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement) {
      throw new HtmlExportParseLimitError(
        `element attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement}`,
      );
    }
    if (this.attributeCount + attrs.length > HTML_EXPORT_PARSE_LIMITS.maxAttributes) {
      throw new HtmlExportParseLimitError(`attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributes}`);
    }
    this.attributeCount += attrs.length;
  }

  private parentOf(node: Node): ParentNode | null {
    if (node.nodeName === '#document-fragment') {
      return this.templateOwners.get(node as DocumentFragment) ?? null;
    }
    return 'parentNode' in node ? node.parentNode : null;
  }

  private ancestryDepth(node: Node): number {
    let depth = 0;
    let current: Node = node;
    const seen = new Set<Node>();
    while (true) {
      if (seen.has(current)) {
        throw new HtmlExportParseLimitError('tree contains a parent cycle');
      }
      seen.add(current);
      const parent = this.parentOf(current);
      if (!parent) return depth;
      depth++;
      current = parent;
    }
  }

  private subtreeHeight(node: Node): number {
    const children = 'childNodes' in node ? node.childNodes : [];
    let height = 0;
    for (const child of children) height = Math.max(height, 1 + this.subtreeHeight(child));
    if (node.nodeName === 'template' && 'content' in node) {
      const contentHeight = 1 + this.subtreeHeight((node as Template).content);
      height = Math.max(height, contentHeight);
    }
    return height;
  }

  private checkAttachment(parent: ParentNode, child: ChildNode): void {
    const deepest = this.ancestryDepth(parent) + 1 + this.subtreeHeight(child);
    if (deepest > HTML_EXPORT_PARSE_LIMITS.maxDepth) {
      throw new HtmlExportParseLimitError(`tree depth exceeds ${HTML_EXPORT_PARSE_LIMITS.maxDepth}`);
    }
    this.maxDepth = Math.max(this.maxDepth, deepest);
  }

  createDocument(): Document {
    this.reserveNode();
    return defaultTreeAdapter.createDocument();
  }

  createDocumentFragment(): DocumentFragment {
    this.reserveNode();
    return defaultTreeAdapter.createDocumentFragment();
  }

  createElement(tagName: string, namespaceURI: html.NS, attrs: Attribute[]): Element {
    this.reserveAttributes(attrs);
    this.reserveNode();
    return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
  }

  createCommentNode(data: string): DefaultTreeAdapterTypes.CommentNode {
    this.reserveNode();
    return defaultTreeAdapter.createCommentNode(data);
  }

  createTextNode(value: string): DefaultTreeAdapterTypes.TextNode {
    this.reserveNode();
    return defaultTreeAdapter.createTextNode(value);
  }

  appendChild(parentNode: ParentNode, newNode: ChildNode): void {
    this.checkAttachment(parentNode, newNode);
    defaultTreeAdapter.appendChild(parentNode, newNode);
  }

  insertBefore(parentNode: ParentNode, newNode: ChildNode, referenceNode: ChildNode): void {
    this.checkAttachment(parentNode, newNode);
    defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode);
  }

  setTemplateContent(templateElement: Template, contentElement: DocumentFragment): void {
    this.templateOwners.set(contentElement, templateElement);
    const deepest = this.ancestryDepth(templateElement) + 1 + this.subtreeHeight(contentElement);
    if (deepest > HTML_EXPORT_PARSE_LIMITS.maxDepth) {
      throw new HtmlExportParseLimitError(`tree depth exceeds ${HTML_EXPORT_PARSE_LIMITS.maxDepth}`);
    }
    this.maxDepth = Math.max(this.maxDepth, deepest);
    defaultTreeAdapter.setTemplateContent(templateElement, contentElement);
  }

  getTemplateContent(templateElement: Template): DocumentFragment {
    return defaultTreeAdapter.getTemplateContent(templateElement);
  }

  setDocumentType(document: Document, name: string, publicId: string, systemId: string): void {
    const existing = document.childNodes.find(
      (node): node is DefaultTreeAdapterTypes.DocumentType => node.nodeName === '#documentType',
    );
    if (existing) {
      existing.name = name;
      existing.publicId = publicId;
      existing.systemId = systemId;
      return;
    }
    this.reserveNode();
    this.checkAttachment(document, { nodeName: '#documentType', name, publicId, systemId, parentNode: null });
    defaultTreeAdapter.setDocumentType(document, name, publicId, systemId);
  }

  setDocumentMode(document: Document, mode: html.DOCUMENT_MODE): void {
    defaultTreeAdapter.setDocumentMode(document, mode);
  }

  getDocumentMode(document: Document): html.DOCUMENT_MODE {
    return defaultTreeAdapter.getDocumentMode(document);
  }

  detachNode(node: ChildNode): void {
    defaultTreeAdapter.detachNode(node);
  }

  insertText(parentNode: ParentNode, text: string): void {
    const previous = parentNode.childNodes[parentNode.childNodes.length - 1];
    if (previous && defaultTreeAdapter.isTextNode(previous)) {
      previous.value += text;
      return;
    }
    this.appendChild(parentNode, this.createTextNode(text));
  }

  insertTextBefore(parentNode: ParentNode, text: string, referenceNode: ChildNode): void {
    const previous = parentNode.childNodes[parentNode.childNodes.indexOf(referenceNode) - 1];
    if (previous && defaultTreeAdapter.isTextNode(previous)) {
      previous.value += text;
      return;
    }
    this.insertBefore(parentNode, this.createTextNode(text), referenceNode);
  }

  adoptAttributes(recipient: Element, attrs: Attribute[]): void {
    const existing = new Set(recipient.attrs.map((attribute) => attribute.name));
    const additions = attrs.filter((attribute) => !existing.has(attribute.name));
    if (recipient.attrs.length + additions.length > HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement) {
      throw new HtmlExportParseLimitError(
        `element attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement}`,
      );
    }
    if (this.attributeCount + additions.length > HTML_EXPORT_PARSE_LIMITS.maxAttributes) {
      throw new HtmlExportParseLimitError(`attribute count exceeds ${HTML_EXPORT_PARSE_LIMITS.maxAttributes}`);
    }
    this.attributeCount += additions.length;
    defaultTreeAdapter.adoptAttributes(recipient, attrs);
  }

  getFirstChild(node: ParentNode): ChildNode | null {
    return defaultTreeAdapter.getFirstChild(node) ?? null;
  }

  getChildNodes(node: ParentNode): ChildNode[] {
    return defaultTreeAdapter.getChildNodes(node);
  }

  getParentNode(node: Node): ParentNode | null {
    return defaultTreeAdapter.getParentNode(node);
  }

  getAttrList(element: Element): Attribute[] {
    return defaultTreeAdapter.getAttrList(element);
  }

  getTagName(element: Element): string {
    return defaultTreeAdapter.getTagName(element);
  }

  getNamespaceURI(element: Element): html.NS {
    return defaultTreeAdapter.getNamespaceURI(element);
  }

  getTextNodeContent(textNode: DefaultTreeAdapterTypes.TextNode): string {
    return defaultTreeAdapter.getTextNodeContent(textNode);
  }

  getCommentNodeContent(commentNode: DefaultTreeAdapterTypes.CommentNode): string {
    return defaultTreeAdapter.getCommentNodeContent(commentNode);
  }

  getDocumentTypeNodeName(doctypeNode: DefaultTreeAdapterTypes.DocumentType): string {
    return defaultTreeAdapter.getDocumentTypeNodeName(doctypeNode);
  }

  getDocumentTypeNodePublicId(doctypeNode: DefaultTreeAdapterTypes.DocumentType): string {
    return defaultTreeAdapter.getDocumentTypeNodePublicId(doctypeNode);
  }

  getDocumentTypeNodeSystemId(doctypeNode: DefaultTreeAdapterTypes.DocumentType): string {
    return defaultTreeAdapter.getDocumentTypeNodeSystemId(doctypeNode);
  }

  isTextNode(node: Node): node is DefaultTreeAdapterTypes.TextNode {
    return defaultTreeAdapter.isTextNode(node);
  }

  isCommentNode(node: Node): node is DefaultTreeAdapterTypes.CommentNode {
    return defaultTreeAdapter.isCommentNode(node);
  }

  isDocumentTypeNode(node: Node): node is DefaultTreeAdapterTypes.DocumentType {
    return defaultTreeAdapter.isDocumentTypeNode(node);
  }

  isElementNode(node: Node): node is Element {
    return defaultTreeAdapter.isElementNode(node);
  }

  setNodeSourceCodeLocation(node: Node, location: Token.ElementLocation | null): void {
    defaultTreeAdapter.setNodeSourceCodeLocation(node, location);
  }

  getNodeSourceCodeLocation(node: Node): Token.ElementLocation | null | undefined {
    return defaultTreeAdapter.getNodeSourceCodeLocation(node);
  }

  updateNodeSourceCodeLocation(node: Node, location: Partial<Token.ElementLocation>): void {
    defaultTreeAdapter.updateNodeSourceCodeLocation(node, location);
  }
}
