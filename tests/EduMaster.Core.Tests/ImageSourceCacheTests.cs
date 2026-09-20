using EduMaster.Web;
namespace EduMaster.Core.Tests;
public class ImageSourceCacheTests:IDisposable
{
    readonly string directory=Path.Combine(Path.GetTempPath(),"edumaster-cache-tests",Guid.NewGuid().ToString("N"));
    [Fact]public async Task NewProcessRestoresIdenticalPagesAndOriginalExpiry(){
        var id=Guid.NewGuid().ToString("N");var now=DateTime.UtcNow;
        await new ImageSourceCache(directory).SaveAsync(id,new([new([1,2,3],"image/png",1),new([4,5],"image/jpeg",2)],now));
        var restored=new ImageSourceCache(directory).Load(now.AddMinutes(20))[id];
        Assert.Equal(now,restored.Created);Assert.Equal(new byte[]{1,2,3},restored.Pages[0].Bytes);Assert.Equal(2,restored.Pages[1].Page);
    }
    [Fact]public async Task StoresOriginalBytesWithoutDuplicatingPreview(){
        var id=Guid.NewGuid().ToString("N");await new ImageSourceCache(directory).SaveAsync(id,new([new([1,2,3],"image/png",1)],DateTime.UtcNow));
        var raw=await File.ReadAllTextAsync(Path.Combine(directory,id+".json"));
        Assert.DoesNotContain("DataUrl",raw);Assert.Contains("AQID",raw);
    }
    [Fact]public async Task ExpiredSourceIsRemovedFromDisk(){
        var id=Guid.NewGuid().ToString("N");await new ImageSourceCache(directory).SaveAsync(id,new([new([1],"image/png",1)],DateTime.UtcNow.AddHours(-3)));
        Assert.Empty(new ImageSourceCache(directory).Load(DateTime.UtcNow));Assert.False(File.Exists(Path.Combine(directory,id+".json")));
    }
    [Fact]public async Task InvalidSourceCannotReenterMemory(){
        var id=Guid.NewGuid().ToString("N");await new ImageSourceCache(directory).SaveAsync(id,new([new([1],"text/html",1)],DateTime.UtcNow));
        Assert.Empty(new ImageSourceCache(directory).Load(DateTime.UtcNow));
    }
    [Fact]public async Task RejectsTraversalId()=>await Assert.ThrowsAsync<ArgumentException>(()=>new ImageSourceCache(directory).SaveAsync("../escape",new([new([1],"image/png",1)],DateTime.UtcNow)));
    public void Dispose(){var root=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"edumaster-cache-tests"))+Path.DirectorySeparatorChar;if(!Path.GetFullPath(directory).StartsWith(root,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException();if(Directory.Exists(directory))Directory.Delete(directory,true);}
}
