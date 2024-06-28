import fetch from 'node-fetch';
import { tmpdir } from 'os';
import { join } from 'path';
import { openSync, readSync, closeSync, existsSync, mkdirSync } from 'fs'; // Import fs for synchronous file operations
import { writeFile } from 'fs/promises';
import { Response } from 'node-fetch';
import { readPdfText } from 'pdf-text-reader';
import axios from 'axios';
import fs from 'fs';
import { file as BunFile } from 'bun';


const PAPERLESS_URL = import.meta.env.PAPERLESS_URL;//"http://localhost:8000";
console.log("PAPERLESS_URL: ", PAPERLESS_URL);

type OpenAITool = {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: any;
    };
};

// Define the type for the function response
interface PdfReaderResult {
    result: any | null;
    error: string | null;
}



async function callOpenaiApi(
    apiKey: string,
    model: string,
    messages: any[],
    tools?: OpenAITool[]
): Promise<{ result: any; error: any }> {
    const url = `https://api.openai.com/v1/models/${model}/completions`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };
    const body = JSON.stringify({
        model,
        messages,
        tools
    });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body
        });
        if (!response.ok) {
            console.error(`API request failed with status ${response.status}`);
            return { result: null, error: `API request failed with status ${response.status}` };
        }
        const data = await response.json();
        return { result: data, error: null };
    }
    catch (error) {
        if (error instanceof Error) {
            return { result: null, error: error.message };
        }
        else {
            // Handle cases where the error is not an instance of Error
            return { result: null, error: String(error) }; // Convert unknown to string
        }
    }
}

export async function createOpenaiChat(
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    passedSchema?: string
): Promise<{ result: any; error: any }> {
    let result: any = null;
    let error: any = null;
    let schemaDictionary: any = null;
    let tool: OpenAITool;

    const toolName = "json_answer";
    const toolDescription = "Generate output using the specified schema";

    if (passedSchema) {
        try {
            schemaDictionary = JSON.parse(passedSchema);
            if (!schemaDictionary) {
                // Error, schema cannot be decoded
                error = "Failed to parse schema JSON"
            } else {
                // Success, schema is a valid JSON object
                console.log("Success: schema is a valid JSON object");
            }
        } catch {
            error = "Error: error while decoding schema: ", passedSchema
        }

        if (error) {
            console.error(error)
            return { result, error };
        }

        tool = {
            type: "function",
            function: {
                name: toolName,
                description: toolDescription,
                parameters: schemaDictionary
            }
        };

        const messages = [
            { role: "system", content: `${systemPrompt}\nProduce your output as a JSON` },
            { role: "user", content: userPrompt }
        ];

        ({ result, error } = await callOpenaiApi(apiKey, model, messages, [tool]));
    }
    else {
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ];
        ({ result, error } = await callOpenaiApi(apiKey, model, messages));
    }
    if (result) console.log(result);
    if (error) console.error(error);

    return { result, error };
}

// Check if the file is a valid PDF
export function isPDF(filePath: string): any {
    const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
    const buffer = Buffer.alloc(4);
    const fileDescriptor = openSync(filePath, 'r');
    readSync(fileDescriptor, buffer, 0, 4, 0);
    closeSync(fileDescriptor);
    let is_a_pdf = buffer.equals(pdfHeader);

    // return the is_a_pdf boolean and the content of the buffer as a string
    let result = { "is_pdf": is_a_pdf, "content": buffer.toString() };
    return result;
}

// read openai key from .env file as OPENAI_API_KEY without using new import
export async function getOpenaiApiKey(): Promise<string> {
    const apiKey = import.meta.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set in .env file');
    }
    return apiKey;
}

export async function generateJsonSchema(tags: string[]): Promise<string> {
    // Read the tags from the .env file
    //const tagsData = import.meta.env.CONTENT_TAGS as string || '';
    //const tags = tagsData.split(',').map(tag => tag.trim());

    // Define the JSON schema
    const schema = {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "Title of the document"
            },
            summary: {
                type: "string",
                description: "Summary of the document"
            },
            tags: {
                type: "array",
                items: {
                    type: "string",
                    enum: tags,
                    description: "Tag relevant to the document, constrained to the provided list of tags"
                }
            }
        },
        required: ["title", "summary", "tags"]
    };

    // Convert schema to JSON string
    const schemaJson = JSON.stringify(schema, null, 2);
    console.log('JSON schema has been generated');
    return schemaJson;
}

const IGNORE_EXISTING_FILE = true;

async function saveFileFromURL(url: string, filename: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    await writeFile(filename, Buffer.from(buffer));
}

async function postFileToPaperless(source_url: string, fileName: string, token: string): Promise<string | null> {

    // Check if the file already exists
    if (!IGNORE_EXISTING_FILE && existsSync(fileName)) {
        console.error(`File already exist at path: ${fileName}`);
        return null;
    }

    const post_response_data = processAndIngestPDF(source_url, fileName, token);
    return post_response_data;
}


export interface PaperlessArchiveResult {
    new_entry: boolean;
    uuid: string | null;
    content: string;
}


export async function processDocumentWithPaperless(source_url: string, hoarder_id: string, token: string): Promise<PaperlessArchiveResult> {
    let paperless_task_uuid: string | null = null;

    if (source_url) {
        console.log("READING FILE from source_url: ", source_url, " and hoarder_id: ", hoarder_id);
        const file_name = `${hoarder_id}.pdf`;
        // check if file exists
        if (existsSync(source_url)) {
            console.log("FILE ALREADY EXIST - nothing to do");
            return { new_entry: false, uuid: "", content: "" };
        }

        paperless_task_uuid = await postFileToPaperless(source_url, file_name, token);
        console.log("PAPERLESS UPLOAD data: ", paperless_task_uuid);

        if (paperless_task_uuid) {
            // see if uuid in in the uploadResponse json
            if (paperless_task_uuid && paperless_task_uuid !== "") {
                console.log("UUID found in upload response:", paperless_task_uuid);
            }
            else {
                console.error("UUID not found in upload response");
                return { new_entry: false, uuid: paperless_task_uuid, content: "" }
            }
            console.log("Document consumption started, task UUID:", paperless_task_uuid);

            // Poll for task completion
            const task_info: TaskResponse | null = await pollPaperlessTaskStatus(paperless_task_uuid, token);
            if (task_info) {
                const task_status = task_info.status;
                const document_uuid = task_info.task_id;

                // todo: let's find the success message
                if (task_status !== 'FAILURE') {
                    console.log("Document processed successfully, document ID:", document_uuid, " with task_status: ", task_status);


                    // Download the paperless archived document, which should be a pdf/a file
                    let document_buffer: ArrayBuffer | null = null;
                    try {
                        document_buffer = await downloadPaperlessDocument(document_uuid, false); // false for archived version by default
                    }
                    catch (error) {
                        console.error(`Error downloading Paperless document: ${error}`);
                        return { new_entry: false, uuid: paperless_task_uuid, content: "" }
                    }
                    console.log("Paperless document downloaded successfully");
                    if (document_buffer) {
                        // Validate the downloaded document is a PDF/A file
                        // Save the PDF document to a temporary directory
                        const temp_dir = join(tmpdir(), 'pdf_temp');
                        if (!existsSync(temp_dir)) mkdirSync(temp_dir);
                        const temp_path = join(temp_dir, `${document_uuid}.pdf`);

                        try {
                            await writeFile(temp_path, Buffer.from(document_buffer));
                            console.log("Paperless PDF/A document saved to:", temp_path);

                            // Continue with the rest of your logic after the file write operation
                        }
                        catch (err) {
                            console.error(`Error saving PDF document: ${err}`);
                            return { new_entry: false, uuid: paperless_task_uuid, content: "" };
                        }

                        console.log("Paperless PDF/A document saved to:", temp_path);

                        // Extract text from PDF
                        let document_text = "";
                        try {
                            document_text = await readPdfText({ filePath: temp_path });
                        }
                        catch (error) {
                            console.error(`Error extracting text from PDF: ${error}`);
                            return { new_entry: false, uuid: paperless_task_uuid, content: "" }
                        }
                        console.log("Extracted Text:", document_text);
                        return { new_entry: true, uuid: paperless_task_uuid, content: document_text };
                    }
                }
                else {
                    console.error("Null UUID returned from Paperless");
                }
            }
        }
    }
    return { new_entry: false, uuid: paperless_task_uuid, content: "" }
}


interface TaskResponse {
    id: number;
    task_id: string;
    task_file_name: string;
    date_created: string;
    date_done: string | null;
    type: string;
    status: string;
    result: string | null;
    acknowledged: boolean;
    related_document: string | null;
}

async function pollPaperlessTaskStatus(taskUuid: string, token: string): Promise<TaskResponse | null> {
    const paperless_token = token;

    const url = PAPERLESS_URL + `/api/tasks/?task_id=${taskUuid}`;
    while (true) {
        let response: any | null = null;
        try {
            response = await fetch(url, {
                headers: { "Authorization": `Token ${paperless_token}` }
            });
        }
        catch (error) {
            console.error(`Failed to fetch task status: CATCH ${error}`);
            return null
        }
        if (!response) {
            console.error(`Failed to fetch task status: No response! ${response}`);
            return null
        }
        if (!response.ok) {
            console.error(`Failed to fetch task status: NOT OK! ${response.statusText}`);
            return null;
        }
        if (response.status == 200) {
            const task_responses = await response.json() as TaskResponse[];
            const task_response = task_responses[0];
            const task_id = task_response.task_id;
            const task_status = task_response.status;
            const task_result = task_response.result;


            console.log("Task responses:", task_responses);
            console.log("Task status:", task_status);

            if (task_status == 'PENDING') {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5 seconds
            }
            console.log("Task result = ", task_result);
            if (task_status !== '' && task_status !== 'PENDING') {
                return task_response;
            }
        }
        else {
            console.error("Error with response with status: ", response.status, " and response: ", response);
            return null;
        }
    }
}

export async function downloadPaperlessDocument(documentId: string, original: boolean): Promise<ArrayBuffer | null> {
    try {
        const paperless_token = import.meta.env.PAPERLESS_API_TOKEN; // This should be securely fetched from environment variables or config
        const originalQuery = original ? "?original=true" : "";
        const url = `http://localhost:8000/api/documents/${documentId}/download/${originalQuery}`;

        const response = await fetch(url, {
            headers: { "Authorization": `Token ${paperless_token}` }
        });

        if (!response.ok) {
            console.error(`Failed to download document: ${response.statusText}`);
            return null;
        }

        return await response.arrayBuffer();
    }
    catch (error) {
        console.error(`Failed to download document: ${error}`);
        return null;
    }
}
async function processAndIngestPDF(pdfUrl: string, fileName: string, token: string): Promise<string | null> {
    const paperlessEndpoint = PAPERLESS_URL + "/api/documents/post_document/";
    const apiKey = token//import.meta.env.PAPERLESS_API_TOKEN;

    console.log("USING: ", pdfUrl, paperlessEndpoint, " with API KEY: ", apiKey);

    let pdfResponse: any | null = null;
    try {
        // Download the PDF file
        pdfResponse = await fetch(pdfUrl);
        console.log(pdfResponse);

        if (!pdfResponse.ok) {
            throw new Error(`Failed to download PDF: ${pdfResponse.statusText}`);
        }
    }
    catch (error) {
        console.error('pdfResponse Error:', error);
        return null;
    }

    let pdfBuffer: Buffer;
    try {
        const pdfArrayBuffer: ArrayBuffer = await pdfResponse.arrayBuffer();
        pdfBuffer = Buffer.from(pdfArrayBuffer);
        console.log("PDF Buffer length:", pdfBuffer.length);

    }
    catch (error) {
        console.error('Error converting response to Buffer:', error);
        return null;
    }

    
    try 
    {
        // Save the PDF file to disk
        await writeFile(fileName, pdfBuffer);
    }
    catch (error)
    {
        console.error('Error saving PDF:', error);
        return null;
    }
    
    const data = uploadDocument(paperlessEndpoint, fileName, apiKey);
    /*
    // Prepare form data
    const formData = new FormData();
    //const docInfo = {filename:fileName, contentType: 'application/pdf'};
    //console.log("docInfo: ", docInfo);
    formData.append('document', pdfBuffer);
    // Append optional fields
    formData.append('document_type', 'application/pdf');
    formData.append('storage_path', fileName);

    // Add any additional required fields
    //formData.append('title', 'Uploaded Document');
    //formData.append('correspondent', '');
    //formData.append('document_type', '');
    //formData.append('tags', '');

    let ingestResponse: Response;
    try {
        // Send to Paperless-ngx
        // console.log("endpoint =", paperlessEndpoint, "token = ", apiKey);
        ingestResponse = await fetch(paperlessEndpoint,
            {
                method: 'POST',
                body: formData,
                headers: { 'Authorization': `Token ${apiKey}` },
            });

        if (!ingestResponse.ok) {
            const errorText = await ingestResponse.text();
            console.error(`Failed to ingest document: ${ingestResponse.statusText}. Details: ${errorText}`);
            return null;
        }
    } catch (error) {
        console.error('Ingest Error:', error);
        return null;
    }

    try {
        const responseData: any = await ingestResponse.json();
        console.log("Ingest response:", responseData);
        return responseData.task_id || null;
    } catch (error) {
        console.error('JSON Parsing Error:', error);
        return null;
    }
        */
    return data;
}


async function uploadDocument(apiURL: string, fileName: string, token: string): Promise<any | null> {
    // Create form data
    const formData = new FormData();
    let file = await createFileObject(fileName);

    if (file) {
        formData.append('document', file, fileName);

        // Optional fields
        // formData.append('title', 'Your Document Title');
        // formData.append('created', '2024-06-28');
        // formData.append('correspondent', 'correspondent_id');
        // Add more fields as needed

        try {
            // Send POST request
            const response = await fetch(apiURL, {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${token}`,
                },
                body: formData as any,
            });

            const responseData = await response.json();
            console.log('Document uploaded:', responseData);

            return responseData;
            // Handle response data (UUID of the consumption task)
        } catch (error) {
            console.error('Error uploading document:', error);
            // Handle error
            return null;
        }
    } else {
        console.error('File creation failed');
        return null;
    }
}

async function createFileObject(filePath: string): Promise<File | null> {
    try {
        const fileContent = await BunFile(filePath).arrayBuffer();
        const fileName = filePath.split('/').pop() || 'file.txt';
        const file = new File([fileContent], fileName, { type: 'application/octet-stream' });

        return file;
    } catch (error) {
        console.error(`Error reading file: ${error}`);
        return null;
    }
}
