import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.REPORTS_TABLE!;

export async function getReport(id: string) {
  return (await doc.send(new GetCommand({ TableName: TABLE, Key: { id } }))).Item;
}

export async function saveReport(report: Record<string, unknown>) {
  await doc.send(new PutCommand({ TableName: TABLE, Item: report }));
}
