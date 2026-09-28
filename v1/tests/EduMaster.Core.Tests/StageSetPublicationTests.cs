using EduMaster.Core;
using EduMaster.Web;
namespace EduMaster.Core.Tests;
public class StageSetPublicationTests
{
    [Fact]public async Task FailedStageStopsLaterPaidWorkAndRetainsPrefixOnReload(){
        var path=Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N"));
        try{
            var job=new GenerationJob{State="failed",Finished=true,Outputs=[Prepared(1),new("deepseek",2,3){State="failed",Error="조건 모순"},new("deepseek",3,3)]};
            Assert.True(job.StopAfterStageFailure(1));Assert.Equal("skipped",job.Outputs[2].State);Assert.Null(job.Outputs[2].Result);Assert.Equal("prepared",job.Outputs[0].State);
            var id=Guid.NewGuid().ToString("N");var cache=new GenerationResultCache(path);await cache.SaveAsync(id,job);
            var restored=cache.Load(DateTime.UtcNow)[id];Assert.Equal("skipped",restored.Outputs[2].State);Assert.NotNull(restored.Outputs[0].Result);
        }finally{if(Directory.Exists(path))Directory.Delete(path,true);}
    }
    private static ProviderJob Prepared(int number){
        var r=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"fp","문제","본문",["1","2","3","4","5"],"① 1","풀이",["단계"],"변형"){
            Quality=new("test",[new("conditions","조건","pass","검토","ai"),new("semantic-math","수치","pass","검토","ai")])};
        return new("deepseek",number,3){State="prepared",Result=r};
    }
    [Fact]public void ResultsStayHiddenUntilEveryStagePasses(){
        var job=new GenerationJob{Outputs=[Prepared(1),Prepared(2),new("deepseek",3,3){State="running"}]};
        Assert.False(job.PublishReviewedSet());Assert.Null(job.VisibleResult(job.Outputs[0]));Assert.Null(job.Result);
        job.Outputs[2]=Prepared(3);Assert.True(job.PublishReviewedSet());
        Assert.All(job.Outputs,o=>{Assert.Equal("ready",o.State);Assert.NotNull(job.VisibleResult(o));});Assert.NotNull(job.Result);
    }
    [Fact]public async Task FailedFinalStageKeepsEarlierDraftsThroughCacheReload(){
        var path=Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N"));
        try{
            var job=new GenerationJob{State="failed",Finished=true,Outputs=[Prepared(1),Prepared(2),new("deepseek",3,3){State="failed",Error="표 오류"}]};
            Assert.False(job.PublishReviewedSet());Assert.NotNull(job.Outputs[0].Result);Assert.Null(job.VisibleResult(job.Outputs[0]));
            var cache=new GenerationResultCache(path);var id=Guid.NewGuid().ToString("N");await cache.SaveAsync(id,job);
            var restored=cache.Load(DateTime.UtcNow)[id];Assert.NotNull(restored.Outputs[0].Result);Assert.Null(restored.VisibleResult(restored.Outputs[0]));
        }finally{if(Directory.Exists(path))Directory.Delete(path,true);}
    }
    [Fact]public void IncompleteSemanticReviewDoesNotPublish(){
        var job=new GenerationJob{Outputs=[Prepared(1),Prepared(2),Prepared(3)]};
        job.Outputs[2].Result=job.Outputs[2].Result! with{Quality=new("test",[new("conditions","조건","unknown","시간 초과","ai")])};
        Assert.False(job.PublishReviewedSet());
    }
    [Theory][InlineData("same",true)][InlineData("changed",false)]
    public void RetryOnlyReusesReviewedDraftsForIdenticalInputs(string fingerprint,bool reuse){
        var registry=new GenerationJobRegistry();
        var old=new GenerationJob{State="failed",Finished=true,RequestFingerprint="same",Outputs=[Prepared(1),Prepared(2),new("deepseek",3,3){State="failed"}]};
        registry.Jobs[Guid.NewGuid().ToString("N")]=old;
        var started=registry.Start(null,fingerprint,()=>new GenerationJob{Outputs=Enumerable.Range(1,3).Select(n=>new ProviderJob("deepseek",n,3)).ToArray()});
        Assert.Equal("started",started.Outcome);
        Assert.Equal(reuse?"prepared":"waiting",started.Job!.Outputs[0].State);
        Assert.Null(started.Job.VisibleResult(started.Job.Outputs[0]));
        Assert.Equal("waiting",started.Job.Outputs[2].State);
        if(reuse){Assert.Equal(old.Outputs[0].Result!.Id,started.Job.Outputs[0].Result!.Id);Assert.Equal(started.Id,started.Job.Outputs[0].Result!.QualityJobId);}
    }
    [Fact]public void EarlierFailureInvalidatesLaterIdeasOnRetry(){
        var registry=new GenerationJobRegistry();
        registry.Jobs[Guid.NewGuid().ToString("N")]=new GenerationJob{State="failed",Finished=true,RequestFingerprint="same",Outputs=[new("deepseek",1,3){State="failed"},Prepared(2),Prepared(3)]};
        var started=registry.Start(null,"same",()=>new GenerationJob{Outputs=Enumerable.Range(1,3).Select(n=>new ProviderJob("deepseek",n,3)).ToArray()});
        Assert.All(started.Job!.Outputs,o=>{Assert.Equal("waiting",o.State);Assert.Null(o.Result);});
    }
    [Fact]public void NewMethodFailureInvalidatesPublishedSetAndResumesOnlyVerifiedPrefix(){
        var old=new GenerationJob{Finished=true,RequestFingerprint="same",Outputs=[Prepared(1),Prepared(2),Prepared(3)]};
        Assert.True(old.PublishReviewedSet());
        old.Outputs[2].Result=old.Outputs[2].Result! with{Quality=new("new-method-check",[
            new("source-method-order","풀이 순서","fail","보조 문자를 원본 STEP보다 먼저 사용했습니다.","code-teacher-method")])};
        old.InvalidateFailedCachedSet();
        Assert.Equal("failed",old.State);Assert.Null(old.Result);
        Assert.Equal("prepared",old.Outputs[0].State);Assert.Equal("prepared",old.Outputs[1].State);
        Assert.Equal("failed",old.Outputs[2].State);Assert.Contains("보조 문자",old.Outputs[2].Error);
        Assert.All(old.Outputs,o=>Assert.Null(old.VisibleResult(o)));
        var registry=new GenerationJobRegistry();registry.Jobs[Guid.NewGuid().ToString("N")]=old;
        var resumed=registry.Start("retry-new-method","same",()=>new GenerationJob{
            Outputs=Enumerable.Range(1,3).Select(n=>new ProviderJob("deepseek",n,3)).ToArray()});
        Assert.Equal("started",resumed.Outcome);
        Assert.Equal(old.Outputs[0].Result!.Id,resumed.Job!.Outputs[0].Result!.Id);
        Assert.Equal(old.Outputs[1].Result!.Id,resumed.Job.Outputs[1].Result!.Id);
        Assert.Equal("waiting",resumed.Job.Outputs[2].State);Assert.Null(resumed.Job.Outputs[2].Result);
    }
}
