using EduMaster.Core;
using EduMaster.Web;
namespace EduMaster.Core.Tests;
public class GenerationResultCacheTests
{
    [Fact]public async Task CompletedResultSurvivesNewServerInstanceAndKeepsRequestIdentity(){
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-job-test-"+Guid.NewGuid().ToString("N"));var id=Guid.NewGuid().ToString("N");
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"fp","덧셈 변형","3+4는?",["5","6","7","8","9"],"③ 7","3+4=7",["확인","계산","7"],"변형");
        var job=new GenerationJob{Finished=true,State="ready",RequestId=id,RequestFingerprint="fp|deepseek",Result=result,Outputs=[new("deepseek"){State="ready",Phase="완료",Result=result}]};
        try{await new GenerationResultCache(directory).SaveAsync(id,job);var restored=new GenerationResultCache(directory).Load(DateTime.UtcNow)[id];Assert.True(restored.Finished);Assert.Equal("ready",restored.State);Assert.Equal(id,restored.RequestId);Assert.Equal(job.RequestFingerprint,restored.RequestFingerprint);Assert.Equal("③ 7",restored.Result!.Answer);Assert.Equal(result.Id,restored.Outputs[0].Result!.Id);restored.Cancel.Dispose();}
        finally{job.Cancel.Dispose();if(Directory.Exists(directory))Directory.Delete(directory,true);}
    }
    [Fact]public async Task ActiveJobIsNotResumedAsCompletedAndExpiredResultIsRemoved(){
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-job-test-"+Guid.NewGuid().ToString("N"));var id=Guid.NewGuid().ToString("N");var job=new GenerationJob{Created=DateTime.UtcNow.AddHours(-3),State="failed",Outputs=[new("deepseek"){State="failed",Error="실패"}]};
        try{var cache=new GenerationResultCache(directory);await cache.SaveAsync(id,job);Assert.False(Directory.Exists(directory));job.Finished=true;await cache.SaveAsync(id,job);Assert.Empty(cache.Load(DateTime.UtcNow));Assert.False(File.Exists(Path.Combine(directory,id+".json")));}
        finally{job.Cancel.Dispose();if(Directory.Exists(directory))Directory.Delete(directory,true);}
    }
    [Fact]public void MalformedCacheCannotPreventStartup(){
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-job-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        try{File.WriteAllText(Path.Combine(directory,Guid.NewGuid().ToString("N")+".json"),"{bad-json");Assert.Empty(new GenerationResultCache(directory).Load(DateTime.UtcNow));}
        finally{Directory.Delete(directory,true);}
    }
    [Fact]public async Task CompletedLearningStagesKeepTheirOrderAndLabels(){
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-job-test-"+Guid.NewGuid().ToString("N"));var id=Guid.NewGuid().ToString("N");
        SampleResult Result(int step)=>new(Guid.NewGuid(),Guid.NewGuid(),"fp"+step,"단계 "+step,"문제 "+step,["1","2","3","4","5"],"① 1","해설",Enumerable.Range(1,step).Select(x=>"STEP "+x).ToArray(),"변형");
        var first=Result(1);var second=Result(2);var job=new GenerationJob{Finished=true,State="ready",RequestId=id,RequestFingerprint="series",Result=second,Outputs=[new("deepseek",1,2,"STEP 1 연습 문제"){State="ready",Phase="완료",Result=first},new("deepseek",2,2,"전체 로직 쌍둥이 문제"){State="ready",Phase="완료",Result=second}]};
        try{await new GenerationResultCache(directory).SaveAsync(id,job);var restored=new GenerationResultCache(directory).Load(DateTime.UtcNow)[id];Assert.Equal([1,2],restored.Outputs.Select(x=>x.StageNumber));Assert.Equal("전체 로직 쌍둥이 문제",restored.Outputs[1].StageLabel);}
        finally{job.Cancel.Dispose();if(Directory.Exists(directory))Directory.Delete(directory,true);}
    }
}
