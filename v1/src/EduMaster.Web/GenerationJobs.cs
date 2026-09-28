using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using EduMaster.Core;
namespace EduMaster.Web;

public sealed class GenerationJobRegistry
{
    public ConcurrentDictionary<string,GenerationJob> Jobs{get;}=new();
    public SemaphoreSlim Gate{get;}=new(1);
    public static string Fingerprint(ProblemDraft draft,string provider,string? sourceFingerprint,bool requiresImage)=>(draft with{Id=Guid.Empty}).Fingerprint()+"|"+provider+"|"+sourceFingerprint+"|"+requiresImage;
    public static string SourceFingerprint(IEnumerable<VisualPage>? pages)
    {
        if(pages is null)return "";
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach(var page in pages){hash.AppendData(Encoding.UTF8.GetBytes($"{page.Page}|{page.MimeType}|{page.MaterialRole}|{page.Bytes.Length}|"));hash.AppendData(page.Bytes);}
        return Convert.ToHexString(hash.GetHashAndReset());
    }
    public (string Outcome,string? Id,GenerationJob? Job) Start(string? requestId,string fingerprint,Func<GenerationJob> create)
    {
        lock(Jobs){
            if(requestId is not null){
                var existing=Jobs.FirstOrDefault(j=>j.Value.RequestId==requestId);
                if(existing.Value is not null){
                    if(existing.Value.RequestFingerprint!=fingerprint)throw new ArgumentException("같은 요청 번호에 다른 자료를 보낼 수 없습니다.");
                    return ("existing",existing.Key,existing.Value);
                }
            }
            var equivalent=Jobs.Where(j=>j.Value.RequestFingerprint==fingerprint)
                .OrderByDescending(j=>j.Value.Created)
                .FirstOrDefault(j=>!j.Value.Finished||Reusable(j.Value));
            if(equivalent.Value is not null)return (equivalent.Value.Finished?"reused":"existing",equivalent.Key,equivalent.Value);
            if(Jobs.Count>=30)return ("full",null,null);
            if(!Gate.Wait(0))return ("busy",null,null);
            try{
                var id=Guid.NewGuid().ToString("N");var job=create();job.RequestId=requestId;job.RequestFingerprint=fingerprint;
                var previous=Jobs.Values.Where(j=>j.Finished&&j.State=="failed"&&j.RequestFingerprint==fingerprint).OrderByDescending(j=>j.Created).FirstOrDefault();
                if(job.IsStageSeries&&previous is not null){
                    foreach(var output in job.Outputs){
                        var saved=previous.Outputs.FirstOrDefault(o=>o.StageNumber==output.StageNumber&&o.StageCount==output.StageCount&&o.Provider==output.Provider&&o.State=="prepared"&&GenerationQualityPolicy.CanCompleteDraft(o.Result?.Quality));
                        // Later integrated drafts may depend on earlier ideas; resume only a verified prefix.
                        if(saved?.Result is null)break;
                        if(saved?.Result is not null){output.Result=saved.Result with{QualityJobId=id};output.State="prepared";output.Phase="이전 사전 검토 통과 초안 복구 · 전체 세트 확인 대기";}
                    }
                }
                Jobs[id]=job;return ("started",id,job);
            }catch{Gate.Release();throw;}
        }
    }
    private static bool Reusable(GenerationJob job)=>job.Finished&&job.State=="ready"&&job.Outputs.Length>0&&job.Outputs.All(o=>Reusable(o));
    private static bool Reusable(ProviderJob output)
    {
        if(output.State!="ready"||output.Result?.Quality is not { } quality||quality.Checks.Any(c=>c.State is "fail" or "skipped"))return false;
        var semantic=quality.Checks.Where(c=>c.Id is "language" or "conditions" or "semantic-math" or "visual-semantics").ToArray();
        return semantic.Length==4&&semantic.All(c=>c.State=="pass");
    }
}

public sealed class GenerationJob
{
    public bool IsStageSeries=>Outputs.Any(o=>o.StageCount>0);
    public SampleResult? VisibleResult(ProviderJob output)=>IsStageSeries&&State!="ready"?null:output.State=="ready"?output.Result:null;
    public void InvalidateFailedCachedSet()
    {
        if(State!="ready"||!Outputs.Any(o=>o.Result?.Quality?.State=="fail"))return;
        State="failed";Result=null;
        Error="새 풀이 보존 검사에서 오류를 확인했습니다. 같은 입력으로 실패한 단계만 다시 만들 수 있습니다.";
        foreach(var output in Outputs){
            if(GenerationQualityPolicy.CanCompleteDraft(output.Result?.Quality)){
                output.State="prepared";output.Phase="기존 검토 통과 초안 보관";
            }else{
                output.State="failed";
                output.Error=string.Join(" | ",output.Result?.Quality?.Checks.Where(c=>c.State=="fail").Select(c=>c.Evidence)??[]);
            }
        }
    }
    public bool PublishReviewedSet()
    {
        if(!IsStageSeries||Outputs.Length==0||Outputs.Any(o=>o.State!="prepared"||!GenerationQualityPolicy.CanCompleteDraft(o.Result?.Quality)))return false;
        foreach(var output in Outputs){output.State="ready";output.Phase="전체 사전 검토 통과 · 완료";}
        Result=Outputs[^1].Result;Phase="전체 문제 사전 검토 통과";State="ready";return true;
    }
    public bool StopAfterStageFailure(int index)
    {
        if(!IsStageSeries||index<0||index>=Outputs.Length||Outputs[index].State is not("failed" or "cancelled"))return false;
        foreach(var later in Outputs.Skip(index+1).Where(o=>o.State=="waiting")){
            later.State="skipped";later.Phase="앞 문제 검토 실패 · 유료 생성 안 함";
            later.Error=$"문제 {Outputs[index].StageNumber}의 오류를 먼저 해결해야 합니다. 추가 토큰을 사용하지 않도록 이 문제는 생성하지 않았습니다.";
        }
        return true;
    }
    public string? RequestId{get;set;}
    public string RequestFingerprint{get;set;}="";
    public DateTime Created{get;init;}=DateTime.UtcNow;
    public CancellationTokenSource Cancel{get;}=new();
    public volatile string State="running",Phase="선택한 모델 연결 확인",Error="";
    public volatile bool Finished,UserCancelled;
    public SampleResult? Result;
    public ProviderJob[] Outputs{get;init;}=[];
    public SemaphoreSlim ReviewGate{get;}=new(1);
}

public sealed class ProviderJob(string provider,int stageNumber=0,int stageCount=0,string? stageLabel=null)
{
    public string Provider{get;}=provider;
    public string Model{get;}=provider=="gemma"?"Gemma 4 12B":DeepSeekVisualGenerator.DisplayName;
    public int StageNumber{get;}=stageNumber;
    public int StageCount{get;}=stageCount;
    public string StageLabel{get;}=stageLabel??"";
    public volatile string State=stageNumber>0?"waiting":"running",Phase=stageNumber>0?"앞 단계 생성 대기":"연결 확인 중",Error="";
    public SampleResult? Result;
}
