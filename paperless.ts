import fetch from 'node-fetch';
import { tmpdir } from 'os';
import { join } from 'path';
import { openSync, readSync, closeSync, existsSync, mkdirSync } from 'fs'; // Import fs for synchronous file operations
import { writeFile } from 'fs/promises';
import { readPdfText } from 'pdf-text-reader';
import { file as BunFile } from 'bun';

const IGNORE_EXISTING_FILE = true;
const PAPERLESS_URL = import.meta.env.PAPERLESS_URL;
console.log("PAPERLESS_URL: ", PAPERLESS_URL);

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

export interface PaperlessArchiveResult {
    new_entry: boolean;
    uuid: number | null;
    content: string;
}
const REPROCESS_EXISTING_DOCUMENTS = true;

function extractDuplicateId(input: string): number | null {
    // Find the last occurrence of '#'
    const hashIndex = input.lastIndexOf('#');
    if (hashIndex === -1) {
        return null;
    }

    // Extract the substring from the '#' to the end of the string
    const substring = input.slice(hashIndex + 1);

    // Find the first sequence of digits in the substring
    const match = substring.match(/(\d+)/);
    if (match) {
        return parseInt(match[1], 10);
    }

    return null;
}

export async function processDocumentWithPaperless(source_url: string, hoarder_id: string, token: string): Promise<PaperlessArchiveResult> {
    let paperless_task_uuid: string | null = null;

    if (source_url) {
        console.log("READING FILE from source_url: ", source_url, " and hoarder_id: ", hoarder_id);
        const file_name = `${hoarder_id}.pdf`;
        // check if file exists
        if (existsSync(source_url) && !IGNORE_EXISTING_FILE) {
            console.log("FILE ALREADY EXIST - nothing to do");
            return { new_entry: false, uuid: null, content: "" };
        }

        // Get the task uuid from paperless
        console.log("Getting task uuid from Paperless using ", source_url, file_name, token);
        paperless_task_uuid = await processAndIngestPDF(source_url, file_name, token);
        console.log("paperless_task_uuid: ", paperless_task_uuid);

        if (!paperless_task_uuid || paperless_task_uuid == "") {
            console.error("Could not get task uuid from Paperless with ", source_url, file_name, token);
            return { new_entry: false, uuid: null, content: "" }
        }

        // Poll for task completion
        const task_info: TaskResponse | null = await pollPaperlessTaskStatus(paperless_task_uuid, token);
        if (!task_info) {
            console.error("Could not get task info from Paperless with ", paperless_task_uuid, token);
            return { new_entry: false, uuid: null, content: "" }
        }

        const task_status = task_info.status;
        let document_id = task_info.id;


        // todo: let's find the success message
        if (task_status == 'FAILURE') {
            console.warn(`FAILURE returned from paperless for task ${paperless_task_uuid}, with task_status: ${task_status} and details ${task_info.result}`);

            // Check if the document already exists in the database
            if (REPROCESS_EXISTING_DOCUMENTS) {
                const duplicate_string = 'It is a duplicate'
                if (task_info.result && task_info.result.includes(duplicate_string)) {
                    console.log(`Duplicate document found with UUID: ${document_id}`);
                    const duplicate_id = extractDuplicateId(task_info.result || '');
                    if (duplicate_id) {
                        console.log(`Duplicate document ID: ${duplicate_id}`);
                        document_id = duplicate_id;
                    }
                    else {
                        console.error(`Could not extract duplicate ID from result: ${task_info.result}`);
                        return { new_entry: false, uuid: document_id, content: "" }
                    }
                }
                else {
                    console.log("Ignoring existing document with UUID: ", document_id);
                    return { new_entry: false, uuid: document_id, content: "" };
                }
                console.log("Reprocessing existing document with UUID: ", document_id);
            }
            else {
                console.log("Ignoring existing document with UUID: ", document_id);
                return { new_entry: false, uuid: document_id, content: "" };
            }
        }

        console.log("Document processed successfully, document ID:", document_id, " with task_status: ", task_status);
        // Download the paperless archived document, which should be a pdf/a file
        let document_filename: string | null = null;
        try {
            document_filename = await downloadPaperlessDocument(document_id, false, token); // false for archived version by default
        }
        catch (error) {
            console.error(`Error downloading Paperless document: ${error}`);
            return { new_entry: false, uuid: document_id, content: "" }
        }
        if (!document_filename) {
            console.error(`Error downloading Paperless document (empty filename)`);
            return { new_entry: false, uuid: document_id, content: "" }
        }

        console.log("Paperless PDF/A document saved to:", document_filename);

        // Extract text from PDF
        let document_text = "";
        try {
            document_text = await readPdfText({ filePath: document_filename });
        }
        catch (error) {
            console.error(`Error extracting text from PDF: ${error}`);
            return { new_entry: false, uuid: document_id, content: "" }
        }
        if (!document_text || document_text == "") {
            console.error(`Error extracting text from PDF`);
            return { new_entry: false, uuid: document_id, content: "" }
        }

        console.log("Extracted Text:", document_text);
        return { new_entry: true, uuid: document_id, content: document_text };

    }

    return { new_entry: false, uuid: null, content: "" };
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
            let task_responses: TaskResponse[] | null;
            try {
                task_responses = await response.json() as TaskResponse[];
            }
            catch (error) {
                console.error(`Failed to parse task status response: CATCH ${error} with response: ${response}`);
                return null;
            }
            if (!task_responses || task_responses.length == 0) {
                console.error(`No task responses found with response: ${response}`);
                return null;
            }
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

export async function downloadPaperlessDocument(documentId: number, original: boolean, token: string): Promise<string | null> {
    const file_dir = "pdf-a";//join("pdf-a", 'pdf_temp');
    if (!existsSync(file_dir)) mkdirSync(file_dir);
    const file_path = join(file_dir, `${documentId}.pdf`);

    const paperless_token = token; // This should be securely fetched from environment variables or config
    const originalQuery = original ? "?original=true" : "";
    const url = `${PAPERLESS_URL}/api/documents/${documentId}/download/${originalQuery}`;

    console.log("Downloading Paperless document from:", url, " with token: ", paperless_token)
    let response: any | null = null;
    try {
        response = await fetch(url, {
            headers: { "Authorization": `Token ${paperless_token}` }
        });
    }
    catch (error) {
        console.error(`Failed to download document: CATCH ${error}`);
        return null;
    }
    if (!response.ok) {
        console.error(`Failed to download document: ${response.statusText}`);
        return null;
    }

    console.log("Paperless document downloaded successfully with response: ", response, " and status: ", response.status, " and statusText: ", response.statusText);
    

    let document_buffer = await response.arrayBuffer();
    console.log("buffer size =", document_buffer.byteLength);
    console.log("Blob =", response.Blob);
    console.log("temp_path = ",file_path);

    if (document_buffer) {
        // Validate the downloaded document is a PDF/A file
        // Save the PDF document to a temporary directory

        try {
            await writeFile(file_path, Buffer.from(document_buffer));
            console.log("Paperless PDF/A document saved to:", file_path);

            // Continue with the rest of your logic after the file write operation
        }
        catch (err) {
            console.error(`Error saving PDF document: ${err}`);
            return null;
        }
    }
    else {
        console.error("Null buffer returned from Paperless");
        return null;
    }

    console.log("Paperless PDF/A document saved to:", file_path);
    return file_path;
}

async function processAndIngestPDF(pdfUrl: string, fileName: string, token: string): Promise<string | null> {
    
    const file_dir = "originals";
    if (!existsSync(file_dir)) mkdirSync(file_dir);
    const file_path = join(file_dir, fileName);

    const paperlessEndpoint = PAPERLESS_URL + "/api/documents/post_document/";
    const apiKey = token//import.meta.env.PAPERLESS_API_TOKEN;

    console.log("USING: ", pdfUrl, paperlessEndpoint, " with API KEY: ", apiKey);

    let pdfResponse: any | null = null;
    try {
        // Download the PDF file
        pdfResponse = await fetch(pdfUrl);

        if (!pdfResponse.ok) {
            throw new Error(`Failed to download PDF: ${pdfResponse.statusText}`);
        }
    }
    catch (error) {
        console.error('pdfResponse Error:', error);
        return null;
    }
    if (!pdfResponse) {
        console.error('pdfResponse is null');
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


    try {
        // Save the PDF file to disk
        await writeFile(file_path, pdfBuffer);
    }
    catch (error) {
        console.error('Error saving PDF:', error);
        return null;
    }

    const data = uploadDocument(paperlessEndpoint, file_path, apiKey);
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
