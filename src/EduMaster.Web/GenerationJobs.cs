using System.Collections.Concurrent;
using EduMaster.Core;
namespace EduMaster.Web;

public sealed class GenerationJobRegistry
{
    public ConcurrentDictionary<string,GenerationJob> Jobs{get;}=new();
    public SemaphoreSlim Gate{get;}=new(1);
    public static string Fingerprint(ProblemDraft draft,string provider,string? sourceId,bool requiresImage)=>(draft with{Id=Guid.Empty}).Fingerprint()+"|"+provider+"|"+sourceId+"|"+requiresImage;
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
            if(Jobs.Count>=30)return ("full",null,null);
            if(!Gate.Wait(0))return ("busy",null,null);
            try{
                var id=Guid.NewGuid().ToString("N");var job=create();job.RequestId=requestId;job.RequestFingerprint=fingerprint;Jobs[id]=job;return ("started",id,job);
            }catch{Gate.Release();throw;}
        }
    }
}

public sealed class GenerationJob
{
    public string? RequestId{get;set;}
    public string RequestFingerprint{get;set;}="";
    public DateTime Created{get;init;}=DateTime.UtcNow;
    public CancellationTokenSource Cancel{get;}=new(TimeSpan.FromSeconds(720));
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
