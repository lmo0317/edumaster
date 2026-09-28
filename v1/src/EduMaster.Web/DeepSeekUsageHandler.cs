using System.Diagnostics;
using System.Text.Json;
using EduMaster.Core;

namespace EduMaster.Web;

public sealed record DeepSeekCallUsage(string Id,string Scope,string Operation,DateTimeOffset Started,int? StatusCode,long DurationMs,
    long? InputTokens,long? OutputTokens,long? TotalTokens,long? ReasoningTokens,string Outcome);
public sealed record DeepSeekUsageSummary(int Calls,long InputTokens,long OutputTokens,long TotalTokens,int UnknownUsageCalls,int PendingCalls);

// The transport records every paid response before downstream format/quality parsing.
// No key, prompt, image, model reply, or question text is written to this ledger.
public sealed class DeepSeekUsageHandler(string directory,HttpMessageHandler inner,bool disablePaidCalls=false):DelegatingHandler(inner)
{
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    private readonly AsyncLocal<Scope?> current=new();
    private sealed class Budget(int maximum){public int Calls;public readonly int Maximum=maximum;}
    private sealed record Scope(string Id,string Operation,Budget Budget);
    public IDisposable BeginScope(string id,string operation,int maximumCalls=18)
    {
        var previous=current.Value;current.Value=new(id,operation,new(maximumCalls));
        return new Restore(()=>current.Value=previous);
    }
    public IDisposable BeginStage(string operation)
    {
        var previous=current.Value;
        if(previous is not null)current.Value=previous with{Operation=operation};
        return new Restore(()=>current.Value=previous);
    }
    public DeepSeekUsageSummary Summary(string scope)
    {
        var rows=Read().Where(r=>r.Scope==scope).ToArray();
        return new(rows.Length,rows.Sum(r=>r.InputTokens??0),rows.Sum(r=>r.OutputTokens??0),rows.Sum(r=>r.TotalTokens??0),
            rows.Count(r=>r.TotalTokens is null&&r.Outcome!="started"),rows.Count(r=>r.Outcome=="started"));
    }
    public DeepSeekCallUsage[] Read()
    {
        if(!Directory.Exists(directory))return [];
        var rows=new List<DeepSeekCallUsage>();
        foreach(var path in Directory.EnumerateFiles(directory,"*.json")){
            try{var row=JsonSerializer.Deserialize<DeepSeekCallUsage>(File.ReadAllText(path),Json);if(row is not null)rows.Add(row);}
            catch(Exception e)when(e is IOException or JsonException or UnauthorizedAccessException){}
        }
        return rows.OrderBy(r=>r.Started).ToArray();
    }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
    {
        if(request.Method!=HttpMethod.Post||request.RequestUri?.Host!="api.deepseek.com"||!request.RequestUri.AbsolutePath.EndsWith("/chat/completions",StringComparison.Ordinal))
            return await base.SendAsync(request,token);
        if(disablePaidCalls)throw new InvalidOperationException("이 검증 서버에서는 유료 모델 호출을 차단했습니다.");
        var scope=current.Value??new(Guid.NewGuid().ToString("N"),"unscoped",new(6));
        lock(scope.Budget){
            if(scope.Budget.Calls>=scope.Budget.Maximum)throw new DeepSeekCallLimitException(scope.Budget.Maximum);
            scope.Budget.Calls++;
        }
        var row=new DeepSeekCallUsage(Guid.NewGuid().ToString("N"),scope.Id,scope.Operation,DateTimeOffset.UtcNow,null,0,null,null,null,null,"started");
        await Write(row); // Refuse a paid call if its initial accounting record cannot be saved.
        var watch=Stopwatch.StartNew();
        try{
            var response=await base.SendAsync(request,token);
            row=row with{StatusCode=(int)response.StatusCode,Outcome="response"};
            if((int)response.StatusCode==402)row=row with{InputTokens=0,OutputTokens=0,TotalTokens=0};
            try{
                await response.Content.LoadIntoBufferAsync(2*1024*1024,token);
                using var json=JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));
                if(json.RootElement.TryGetProperty("usage",out var usage)){
                    static long? Number(JsonElement value,string name)=>value.TryGetProperty(name,out var n)&&n.TryGetInt64(out var number)&&number>=0?number:null;
                    var input=Number(usage,"prompt_tokens");var output=Number(usage,"completion_tokens");
                    var total=Number(usage,"total_tokens")??(input is not null&&output is not null?input+output:null);
                    var reasoning=usage.TryGetProperty("completion_tokens_details",out var details)?Number(details,"reasoning_tokens"):null;
                    row=row with{InputTokens=input,OutputTokens=output,TotalTokens=total,ReasoningTokens=reasoning};
                }
            }catch(JsonException){row=row with{Outcome="unparseable-response"};}
            catch{response.Dispose();throw;}
            return response;
        }catch(OperationCanceledException){row=row with{Outcome="cancelled-usage-unknown"};throw;}
        catch{row=row with{Outcome="request-failed-usage-unknown"};throw;}
        finally{await Write(row with{DurationMs=watch.ElapsedMilliseconds});}
    }
    private async Task Write(DeepSeekCallUsage row)
    {
        Directory.CreateDirectory(directory);
        var path=Path.Combine(directory,row.Id+".json");var temp=path+".tmp";
        await File.WriteAllTextAsync(temp,JsonSerializer.Serialize(row,Json));File.Move(temp,path,true);
    }
    private sealed class Restore(Action restore):IDisposable{public void Dispose()=>restore();}
}
