import { ToolRegistry } from "../core/tools.ts"
import { bashTool } from "./bash.ts"
import { editFileTool, globTool, listFilesTool, readFileTool } from "./fs.ts"
import { grepTool } from "./grep.ts"
import { webFetchTool, webSearchTool } from "./web.ts"

/** The seven core tools. Anything else belongs in a plugin or a skill. */
export function coreTools(): ToolRegistry {
	return new ToolRegistry().register(
		readFileTool,
		listFilesTool,
		editFileTool,
		globTool,
		grepTool,
		bashTool,
		webFetchTool,
	)
}

export {
	bashTool,
	editFileTool,
	globTool,
	grepTool,
	listFilesTool,
	readFileTool,
	webFetchTool,
	webSearchTool,
}
