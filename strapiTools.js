/**
 * strapiTools.js
 *
 * Defines the Groq-compatible tool schemas and implements the Strapi API
 * integration functions. This module acts as the "MCP layer" — translating
 * LLM tool calls into concrete Strapi REST API requests.
 */

const axios = require('axios');
const pdfParse = require('pdf-parse');
const qs = require('qs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max characters for any tool result sent back to the LLM */
const MAX_RESULT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';

/** Pre-configured axios instance for Strapi API calls */
const strapiClient = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
  // Strapi requires bracket-notation for nested params (e.g. filters[title][$eq]=hello)
  paramsSerializer: (params) => qs.stringify(params, { encodeValuesOnly: true }),
});

// ---------------------------------------------------------------------------
// Tool Definitions (Groq-compatible JSON Schema)
// ---------------------------------------------------------------------------

/**
 * Tool definitions array to be sent to Groq alongside the user prompt.
 * We define a single, versatile tool `access_strapi_cms` that the LLM
 * can call with different `action` values to perform various operations.
 */
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'access_strapi_cms',
      description:
        'Access the Strapi CMS to manage content. Supports listing available collections, ' +
        'retrieving entries from a collection, getting a single entry by ID, and reading/extracting ' +
        'text from PDF attachments stored in Strapi entries. ' +
        'IMPORTANT: If you do not know the numeric entry ID, use "get_entries" with filters first to search by title or other fields, then use the ID from the result.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_collections',
              'get_entries',
              'get_entry',
              'create_entry',
              'update_entry',
              'delete_entry',
              'read_attachment',
            ],
            description:
              'The action to perform. ' +
              '"list_collections" — list all available content types. Use "search" parameter to filter by name (e.g. search="venue" to find venue-related collections). ' +
              '"get_entries" — list all entries in a collection. Use filters to search by field values. Use this FIRST if you do not know the entry ID. ' +
              '"get_entry" — get a single entry by its numeric ID (requires "collection" and "entry_id"). Only use when you have an actual numeric ID. ' +
              '"create_entry" — create a new entry in a collection (requires "collection" and "data"). ' +
              '"update_entry" — update an existing entry (requires "collection", "entry_id", and "data"). ' +
              '"delete_entry" — delete an entry (requires "collection" and "entry_id"). ' +
              '"read_attachment" — extract text from a PDF attachment in an entry (requires "collection" and "entry_id").',
          },
          collection: {
            type: 'string',
            description:
              'The REST API route name (pluralName) of the Strapi collection, e.g. "articles", "products", "pages". ' +
              'This is the plural form used in the API URL /api/{collection}. ' +
              'Use list_collections to discover the correct route name. ' +
              'Required for get_entries, get_entry, create_entry, update_entry, delete_entry, and read_attachment actions.',
          },
          entry_id: {
            type: 'string',
            description:
              'The numeric ID of a specific entry as a string, e.g. "5", "12". ' +
              'Required for get_entry and read_attachment actions. ' +
              'Must be an actual numeric ID — do NOT pass placeholder text. If you do not know the ID, use get_entries with filters first.',
          },
          filters: {
            type: 'object',
            description:
              'Optional Strapi-style filter parameters for get_entries action. ' +
              'Example: {"title": {"$contains": "hello"}} or {"metaTitle": {"$eq": "My Article"}}. ' +
              'Use this to search for entries when you do not know the ID.',
          },
          data: {
            type: 'object',
            description:
              'The data payload for create_entry and update_entry actions. ' +
              'Must contain the field values to set. ' +
              'Example: {"title": "New Article", "content": "Hello world"}. ' +
              'Use get_entry first to see existing field names before updating.',
          },
          search: {
            type: 'string',
            description:
              'Optional search keyword for list_collections action. ' +
              'Filters collections whose route or display name contains this keyword (case-insensitive). ' +
              'Example: "venue" will match collections like "venues", "venue-categories", etc. ' +
              'Use this to quickly find the correct collection when the user mentions a name.',
          },
        },
        required: ['action'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Execution Dispatcher
// ---------------------------------------------------------------------------

/**
 * Executes a tool call by routing to the appropriate handler function.
 *
 * @param {string} toolName - The name of the tool (should be 'access_strapi_cms')
 * @param {object} args     - The parsed arguments from the LLM tool call
 * @returns {Promise<string>} - JSON string result to feed back to the LLM
 */
async function executeToolCall(toolName, args) {
  if (toolName !== 'access_strapi_cms') {
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  const { action, filters, search } = args;

  // Parse data if the LLM sends it as a JSON string instead of an object
  let data = args.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return JSON.stringify({
        error: `Invalid data format. "data" must be a JSON object, not a string. Got: ${data.substring(0, 100)}`,
      });
    }
  }

  // Normalize collection name to lowercase — Strapi API routes are always lowercase
  const collection = args.collection ? args.collection.toLowerCase() : undefined;

  // Coerce entry_id to a number (LLM may send it as a string)
  // Reject placeholder text like "entry_id_from_get_entries" immediately
  let entry_id = undefined;
  if (args.entry_id) {
    entry_id = parseInt(args.entry_id, 10);
    if (isNaN(entry_id)) {
      return JSON.stringify({
        error: `Invalid entry_id "${args.entry_id}". entry_id must be a real numeric ID (e.g. "5", "12"). ` +
          'Use get_entries with filters first to find entries and get their numeric IDs.',
      });
    }
  }

  try {
    switch (action) {
      case 'list_collections':
        return await listCollections(search);

      case 'get_entries':
        if (!collection) {
          return JSON.stringify({
            error: 'Parameter "collection" is required for get_entries action.',
          });
        }
        return await getEntries(collection, filters);

      case 'get_entry':
        if (!collection || !entry_id) {
          return JSON.stringify({
            error:
              'Parameters "collection" and "entry_id" are required for get_entry action.',
          });
        }
        return await getEntry(collection, entry_id);

      case 'create_entry':
        if (!collection || !data) {
          return JSON.stringify({
            error:
              'Parameters "collection" and "data" are required for create_entry action.',
          });
        }
        return await createEntry(collection, data);

      case 'update_entry':
        if (!collection || !entry_id || !data) {
          return JSON.stringify({
            error:
              'Parameters "collection", "entry_id", and "data" are required for update_entry action.',
          });
        }
        return await updateEntry(collection, entry_id, data);

      case 'delete_entry':
        if (!collection || !entry_id) {
          return JSON.stringify({
            error:
              'Parameters "collection" and "entry_id" are required for delete_entry action.',
          });
        }
        return await deleteEntry(collection, entry_id);

      case 'read_attachment':
        if (!collection || !entry_id) {
          return JSON.stringify({
            error:
              'Parameters "collection" and "entry_id" are required for read_attachment action.',
          });
        }
        return await readAttachment(collection, entry_id);

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const message =
      error.response?.data?.error?.message ||
      error.response?.statusText ||
      error.message;
    const status = error.response?.status || 'N/A';

    return JSON.stringify({
      error: `Strapi API error (status ${status}): ${message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

/**
 * Lists all available content types (collections & single types) from Strapi.
 * Uses the Content-Type Builder API to discover collections dynamically.
 */
async function listCollections(search) {
  try {
    // Primary: Use Content-Type Builder API (requires admin or full-access token)
    const { data } = await strapiClient.get(
      '/api/content-type-builder/content-types'
    );

    // Filter to only user-defined content types (api::)
    const userTypes = data.data.filter((ct) =>
      ct.uid.startsWith('api::')
    );

    // Only return route (pluralName) and displayName to minimize token usage
    // Strapi v4 REST API uses pluralName as the route, NOT apiID
    let collections = userTypes.map((ct) => ({
      route: ct.schema.pluralName,
      name: ct.schema.displayName,
    }));

    // Apply search filter if provided
    if (search) {
      const keyword = search.toLowerCase();
      collections = collections.filter((c) =>
        c.route.toLowerCase().includes(keyword) ||
        c.name.toLowerCase().includes(keyword)
      );
    }

    const message = search
      ? `Found ${collections.length} collection(s) matching "${search}". Use the "route" value as the "collection" parameter in other actions.`
      : `Found ${collections.length} content type(s). Use the "route" value as the "collection" parameter in other actions.`;

    // Use a larger limit for list_collections since it can contain many items
    return truncateResult({ message, collections }, 12000);
  } catch (primaryError) {
    // Fallback: Try the content-type-builder info endpoint
    try {
      const { data } = await strapiClient.get(
        '/content-type-builder/content-types'
      );

      const userTypes = (data.data || []).filter((ct) =>
        ct.uid?.startsWith('api::')
      );

      let collections = userTypes.map((ct) => ({
        route: ct.schema?.pluralName,
        name: ct.schema?.displayName,
      }));

      // Apply search filter if provided
      if (search) {
        const keyword = search.toLowerCase();
        collections = collections.filter((c) =>
          c.route?.toLowerCase().includes(keyword) ||
          c.name?.toLowerCase().includes(keyword)
        );
      }

      const message = search
        ? `Found ${collections.length} collection(s) matching "${search}". Use the "route" value as the "collection" parameter in other actions.`
        : `Found ${collections.length} content type(s). Use the "route" value as the "collection" parameter in other actions.`;

      return truncateResult({ message, collections }, 12000);
    } catch (_fallbackError) {
      const message =
        primaryError.response?.data?.error?.message ||
        primaryError.response?.statusText ||
        primaryError.message;
      const status = primaryError.response?.status || 'N/A';

      return JSON.stringify({
        error: `Could not list collections (status ${status}): ${message}. ` +
          'Try using get_entries with a known collection name instead.',
      });
    }
  }
}

/**
 * Retrieves all entries from a given collection, with optional filters.
 *
 * @param {string} collection - The API ID of the collection
 * @param {object} [filters]  - Optional Strapi filter parameters
 */
async function getEntries(collection, filters) {
  const params = {
    populate: '*',
    publicationState: 'preview', // Include both draft and published entries
    'pagination[pageSize]': 25, // Limit results to save tokens
  };

  if (filters && typeof filters === 'object') {
    params.filters = filters;
  }

  const { data } = await strapiClient.get(`/api/${collection}`, { params });

  const entries = data.data;
  const count = Array.isArray(entries) ? entries.length : 1;
  const total = data.meta?.pagination?.total || count;

  // Strip heavy nested relation/media data to save tokens
  const trimmedEntries = (Array.isArray(entries) ? entries : [entries]).map((entry) =>
    trimEntry(entry)
  );

  return truncateResult({
    message: `Showing ${count} of ${total} total entry/entries from "${collection}".`,
    data: trimmedEntries,
  });
}

/**
 * Retrieves a single entry by ID from a given collection.
 *
 * @param {string} collection - The API ID of the collection
 * @param {number} entryId    - The entry ID
 */
async function getEntry(collection, entryId) {
  const { data } = await strapiClient.get(
    `/api/${collection}/${entryId}`,
    { params: { populate: '*', publicationState: 'preview' } }
  );

  return truncateResult({
    message: `Retrieved entry #${entryId} from "${collection}".`,
    data: trimEntry(data.data),
  });
}

/**
 * Creates a new entry in a given collection.
 *
 * @param {string} collection - The API ID of the collection
 * @param {object} entryData  - The field values for the new entry
 */
async function createEntry(collection, entryData) {
  const { data } = await strapiClient.post(`/api/${collection}`, {
    data: entryData,
  });

  return JSON.stringify({
    message: `Successfully created new entry in "${collection}" with ID ${data.data.id}.`,
    data: data.data,
  });
}

/**
 * Updates an existing entry in a given collection.
 *
 * @param {string} collection - The API ID of the collection
 * @param {number} entryId    - The entry ID to update
 * @param {object} entryData  - The field values to update
 */
async function updateEntry(collection, entryId, entryData) {
  const { data } = await strapiClient.put(`/api/${collection}/${entryId}`, {
    data: entryData,
  });

  return JSON.stringify({
    message: `Successfully updated entry #${entryId} in "${collection}".`,
    data: data.data,
  });
}

/**
 * Deletes an entry from a given collection.
 *
 * @param {string} collection - The API ID of the collection
 * @param {number} entryId    - The entry ID to delete
 */
async function deleteEntry(collection, entryId) {
  const { data } = await strapiClient.delete(`/api/${collection}/${entryId}`);

  return JSON.stringify({
    message: `Successfully deleted entry #${entryId} from "${collection}".`,
    data: data.data,
  });
}

/**
 * Finds and extracts text from PDF attachments within a Strapi entry.
 * Recursively scans all fields for PDF file URLs, downloads them, and
 * extracts text content using pdf-parse.
 *
 * @param {string} collection - The API ID of the collection
 * @param {number} entryId    - The entry ID
 */
async function readAttachment(collection, entryId) {
  // 1. Fetch the entry with all populated relations
  const { data } = await strapiClient.get(
    `/api/${collection}/${entryId}`,
    { params: { populate: '*', publicationState: 'preview' } }
  );

  const entry = data.data;

  // 2. Recursively find all PDF URLs in the entry data
  const pdfUrls = findPdfUrls(entry);

  if (pdfUrls.length === 0) {
    return JSON.stringify({
      message: `No PDF attachments found in entry #${entryId} of "${collection}".`,
      data: entry,
    });
  }

  // 3. Download and extract text from each PDF
  const results = [];

  for (const pdfInfo of pdfUrls) {
    try {
      const fullUrl = pdfInfo.url.startsWith('http')
        ? pdfInfo.url
        : `${STRAPI_URL}${pdfInfo.url}`;

      const response = await axios.get(fullUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const pdfData = await pdfParse(Buffer.from(response.data));
      let text = pdfData.text || '';

      // Truncate to avoid exceeding Groq context window
      const MAX_CHARS = 6000;
      const wasTruncated = text.length > MAX_CHARS;
      if (wasTruncated) {
        text = text.substring(0, MAX_CHARS);
      }

      results.push({
        field: pdfInfo.field,
        fileName: pdfInfo.name,
        pages: pdfData.numpages,
        extractedText: text,
        truncated: wasTruncated,
      });
    } catch (err) {
      results.push({
        field: pdfInfo.field,
        fileName: pdfInfo.name,
        error: `Failed to process PDF: ${err.message}`,
      });
    }
  }

  return JSON.stringify({
    message: `Processed ${results.length} PDF attachment(s) from entry #${entryId}.`,
    attachments: results,
  });
}

// ---------------------------------------------------------------------------
// Utility: Recursive PDF URL Finder
// ---------------------------------------------------------------------------

/**
 * Recursively traverses an object to find all PDF file references.
 * Looks for objects with a `.url` property ending in `.pdf`.
 *
 * @param {any}    obj       - The object to search
 * @param {string} [path=''] - Current field path (for reporting)
 * @returns {Array<{url: string, name: string, field: string}>}
 */
function findPdfUrls(obj, path = '') {
  const pdfs = [];

  if (!obj || typeof obj !== 'object') {
    return pdfs;
  }

  // Check if this object itself is a PDF file reference
  if (obj.url && typeof obj.url === 'string' && obj.url.toLowerCase().endsWith('.pdf')) {
    pdfs.push({
      url: obj.url,
      name: obj.name || 'unknown.pdf',
      field: path || 'root',
    });
    return pdfs;
  }

  // Recurse into arrays and nested objects
  const entries = Array.isArray(obj)
    ? obj.map((item, i) => [`${path}[${i}]`, item])
    : Object.entries(obj).map(([key, val]) => [path ? `${path}.${key}` : key, val]);

  for (const [fieldPath, value] of entries) {
    pdfs.push(...findPdfUrls(value, fieldPath));
  }

  return pdfs;
}

// ---------------------------------------------------------------------------
// Utility: Response Optimization
// ---------------------------------------------------------------------------

/**
 * Truncates a result object to MAX_RESULT_CHARS to stay within
 * the LLM's context window and avoid token limit errors.
 *
 * @param {object} obj - The result object to serialize
 * @returns {string} - JSON string, possibly truncated
 */
function truncateResult(obj, maxChars = MAX_RESULT_CHARS) {
  const json = JSON.stringify(obj);
  if (json.length <= maxChars) {
    return json;
  }

  // Truncate and add a notice
  const truncated = json.substring(0, maxChars);
  return truncated + '...[TRUNCATED — ask user to be more specific or use filters]';
}

/**
 * Trims an entry object by flattening nested relations and media
 * to just their essential fields (id, name/title, url).
 * This dramatically reduces token count for entries with deep relations.
 *
 * @param {object} entry - A Strapi entry object
 * @returns {object} - Trimmed entry
 */
function trimEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;

  const trimmed = {};

  for (const [key, value] of Object.entries(entry)) {
    if (value === null || value === undefined) {
      continue; // Skip null values entirely
    }

    if (Array.isArray(value)) {
      // For arrays of relations/media, keep only id + identifying fields
      trimmed[key] = value.slice(0, 10).map((item) => {
        if (item && typeof item === 'object' && item.id) {
          return {
            id: item.id,
            ...(item.name ? { name: item.name } : {}),
            ...(item.title ? { title: item.title } : {}),
            ...(item.url ? { url: item.url } : {}),
            ...(item.slug ? { slug: item.slug } : {}),
          };
        }
        return item;
      });
      if (value.length > 10) {
        trimmed[key].push(`...and ${value.length - 10} more`);
      }
    } else if (typeof value === 'object' && value.id && value.attributes) {
      // Strapi v4 relation format: { id, attributes: {...} }
      trimmed[key] = { id: value.id, ...trimStrapiAttributes(value.attributes) };
    } else if (typeof value === 'object' && value.data) {
      // Strapi v4 nested data wrapper: { data: { id, attributes } }
      if (Array.isArray(value.data)) {
        trimmed[key] = value.data.slice(0, 5).map((d) => ({
          id: d.id,
          ...(d.attributes ? trimStrapiAttributes(d.attributes) : {}),
        }));
      } else if (value.data && value.data.id) {
        trimmed[key] = { id: value.data.id, ...(value.data.attributes ? trimStrapiAttributes(value.data.attributes) : {}) };
      } else {
        trimmed[key] = value;
      }
    } else {
      trimmed[key] = value;
    }
  }

  return trimmed;
}

/**
 * Extracts only scalar (non-object) attributes from a Strapi attributes object.
 * Keeps string, number, boolean fields; reduces nested objects to just their id.
 */
function trimStrapiAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return {};
  const result = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'object') {
      result[k] = v; // Keep scalar values
    }
    // Skip nested objects/arrays to save tokens
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  toolDefinitions,
  executeToolCall,
};
