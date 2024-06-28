
type OpenAITool = {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: any;
    };
};

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


// read openai key from .env file as OPENAI_API_KEY without using new import
export async function getOpenaiApiKey(): Promise<string> {
    const apiKey = import.meta.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set in .env file');
    }
    return apiKey;
}
