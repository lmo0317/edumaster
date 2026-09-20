using System.Text.Json;
using System.Text.RegularExpressions;
using EduMaster.Core;
namespace EduMaster.Web;
public sealed class GenerationResultCache(string directory)
{
    public static readonly TimeSpan Retention=TimeSpan.FromHours(2);
    private const long MaxBytes=64*1024*1024,MaxTotalBytes=256*1024*1024;
    private readonly SemaphoreSlim saveGate=new(1);
    private static readonly JsonSerializerOptions Options=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
    private sealed record Output(string Provider,string State,string Phase,string Error,SampleResult? Result,int StageNumber=0,int StageCount=0,string StageLabel="");
    private sealed record Snapshot(string Id,DateTime Created,string? RequestId,string RequestFingerprint,string State,string Error,Output[] Outputs);
    public async Task SaveAsync(string id,GenerationJob job,CancellationToken token=default)
    {
        if(!ValidId(id)||!job.Finished||job.State is not("ready" or "failed" or "cancelled"))return;
        await saveGate.WaitAsync(token);try{
        Directory.CreateDirectory(directory);
        var snapshot=new Snapshot(id,job.Created,job.RequestId,job.RequestFingerprint,job.State,job.Error,job.Outputs.Select(o=>new Output(o.Provider,o.State,o.Phase,o.Error,o.Result,o.StageNumber,o.StageCount,o.StageLabel)).ToArray());
        var bytes=JsonSerializer.SerializeToUtf8Bytes(snapshot,Options);if(bytes.LongLength>MaxBytes)throw new IOException("Job result cache exceeds size limit.");
        var path=Path.Combine(directory,id+".json");var temp=Path.Combine(directory,id+".tmp");
        var total=Directory.EnumerateFiles(directory,"*.json").Where(p=>p!=path).Sum(p=>new FileInfo(p).Length);
        if(total+bytes.LongLength>MaxTotalBytes)throw new IOException("Job result cache storage is full.");
        try{await File.WriteAllBytesAsync(temp,bytes,token);File.Move(temp,path,true);}finally{if(File.Exists(temp))File.Delete(temp);}
        }finally{saveGate.Release();}
    }
    public Dictionary<string,GenerationJob> Load(DateTime now)
    {
        var results=new Dictionary<string,GenerationJob>();if(!Directory.Exists(directory))return results;
        long total=0;
        foreach(var path in Directory.EnumerateFiles(directory,"*.json").OrderByDescending(File.GetLastWriteTimeUtc)){
            if(!ValidId(Path.GetFileNameWithoutExtension(path)))continue;
            try{
                var size=new FileInfo(path).Length;if(size>MaxBytes||size+total>MaxTotalBytes||results.Count>=30)continue;
                var snapshot=JsonSerializer.Deserialize<Snapshot>(File.ReadAllBytes(path),Options);
                if(snapshot is null||snapshot.Id!=Path.GetFileNameWithoutExtension(path)||snapshot.Created>now.AddMinutes(1)||now-snapshot.Created>Retention){File.Delete(path);continue;}
                if(snapshot.State is not("ready" or "failed" or "cancelled")||snapshot.Outputs is null||snapshot.Outputs.Length is <1 or >ProblemDraft.MaxLogicSteps||snapshot.Outputs.Any(o=>o is null)||snapshot.RequestFingerprint is null||snapshot.Error is null||snapshot.RequestId is not null&&!ValidId(snapshot.RequestId))continue;
                var outputs=snapshot.Outputs.Select(o=>{
                    if(o.Provider is not("gemma" or "deepseek")||o.State is not("ready" or "failed" or "cancelled")||o.Phase is null||o.Error is null||o.State=="ready"&&o.Result is null||o.Result is { } r&&(r.Drawings is null||r.Diagrams is null||r.Choices is null||r.Steps is null))throw new InvalidDataException("Invalid cached output.");
                    if(o.StageNumber<0||o.StageCount<0||o.StageNumber>o.StageCount||o.StageCount>ProblemDraft.MaxLogicSteps)throw new InvalidDataException("Invalid cached stage metadata.");
                    return new ProviderJob(o.Provider,o.StageNumber,o.StageCount,o.StageLabel){State=o.State,Phase=o.Phase,Error=o.Error,Result=o.Result};
                }).ToArray();
                var result=outputs.FirstOrDefault(o=>o.State=="ready")?.Result;
                if(snapshot.State=="ready"&&result is null)continue;
                var job=new GenerationJob{Created=snapshot.Created,RequestId=snapshot.RequestId,RequestFingerprint=snapshot.RequestFingerprint,State=snapshot.State,Error=snapshot.Error,Phase=snapshot.State=="ready"?"완료 · 보관된 결과 복구":"보관된 작업 복구",Outputs=outputs,Result=result,Finished=true};
                results[snapshot.Id]=job;total+=size;
            }catch(Exception e)when(e is IOException or JsonException or ArgumentException or InvalidOperationException){continue;}
        }
        return results;
    }
    public void Remove(string id){if(ValidId(id))File.Delete(Path.Combine(directory,id+".json"));}
    private static bool ValidId(string id)=>Regex.IsMatch(id,"^[a-f0-9]{32}$",RegexOptions.CultureInvariant);
}
